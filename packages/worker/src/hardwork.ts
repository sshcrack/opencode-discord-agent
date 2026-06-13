import os from "node:os";
import path from "node:path";
import { WORKER_ID } from "./env";
import { client, postInfo } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { runPlanAgent } from "./plan";
import { runOpencodeStreaming } from "./opencode";

interface IndividualPlan {
  index: number;
  planMd: string;
  sessionId: string;
}

function buildSynthesisPrompt(
  job: Job,
  plans: { index: number; planMd: string }[],
  issueNumber: number | null,
  synthesisPlanFile: string,
): string {
  const issueRef = issueNumber ? ` The related GitHub issue is #${issueNumber}.` : "";

  const plansBlock = plans.map((p, i) =>
    `---\n## Plan ${i + 1}\n\n${p.planMd}\n`
  ).join("\n");

  const writeInstruction = `Write the synthesized plan to \`${synthesisPlanFile}\` (create the directory if it doesn't exist). Do NOT ask questions — synthesize directly based on the plans provided.`;

  return [
    `You are a senior architect evaluating ${plans.length} plans for a ${job.kind} task on ${job.repoSlug}.${issueRef}`,
    `Review each plan below, identify what's good and what's bad about each, then synthesize one final plan that extracts the best parts from all of them.`,
    `The final plan will be displayed in a full-featured Markdown viewer that supports Mermaid diagrams, LaTeX, code blocks, etc. Use these liberally.`,
    `The plan should cover: files to change, approach, and any risk areas.`,
    `\n\n## Plans to Evaluate\n\n${plansBlock}`,
    `\n\n${writeInstruction}`,
  ].join("\n\n");
}

async function waitForHardworkSelection(
  jobId: number,
): Promise<{ planMd: string; sessionId: string } | null> {
  jobLog(jobId, `Waiting for user to select a plan (polling every 2s)...`);

  while (true) {
    await Bun.sleep(2000);

    const status = await client.getJobStatus.query({ jobId, workerId: WORKER_ID }).catch(() => null);
    if (!status) continue;

    if (status.status === "cancelled" || status.status === "failed") {
      return null;
    }

    if (status.selectedPlanIndex !== null && status.planMd) {
      jobLog(jobId, `User selected plan index ${status.selectedPlanIndex}`);
      return { planMd: status.planMd, sessionId: status.opencodeSessionId ?? "" };
    }
  }
}

/** Parse the `hardworkIndividualPlans` JSON column into a typed array, tolerating bad/missing data. */
function parseIndividualPlans(raw: string | null | undefined): IndividualPlan[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((p): p is IndividualPlan =>
        !!p && typeof p.index === "number" && typeof p.planMd === "string");
    }
  } catch {
    // ignore malformed JSON
  }
  return [];
}

/** Persist a single completed plan-agent result immediately, so it survives a worker restart. */
async function savePlanProgress(jobId: number, plan: IndividualPlan): Promise<void> {
  await client.hardworkPlanProgress.mutate({
    jobId,
    index: plan.index,
    planMd: plan.planMd,
    sessionId: plan.sessionId,
  }).catch((err) => {
    jobLog(jobId, `Failed to persist hardwork plan ${plan.index} progress (non-fatal): ${err}`);
  });
}

/**
 * Runs the full hardwork flow: N parallel plan agents followed by a
 * synthesis pass. Restart-safe — already-completed individual plans (whether
 * checkpointed in the DB via `hardworkIndividualPlans`, or recovered from
 * plan files left on disk by a previous run) are reused rather than re-run.
 */
async function runHardworkFlow(
  job: Job,
  worktreePath: string,
  issueNumber: number | null,
  helperPath: string,
): Promise<{ planMd: string; sessionId: string } | null> {
  const total = job.parallelPlanCount;
  const planDir = path.join(worktreePath, ".opencode", "plans");

  // ── Recover already-completed individual plans ─────────────────────────
  const completed = new Map<number, IndividualPlan>();
  for (const p of parseIndividualPlans(job.hardworkIndividualPlans)) {
    completed.set(p.index, p);
  }

  const recoveredFromDisk: number[] = [];
  for (let i = 0; i < total; i++) {
    if (completed.has(i)) continue;

    // Fall back to plan files left on disk by a previous run that crashed
    // before its progress could be persisted to the DB (or before this
    // checkpointing existed at all).
    const planFilePath = path.join(planDir, `plan-hardwork-${job.id}-${i}.md`);
    const file = Bun.file(planFilePath);
    if (await file.exists()) {
      const content = await file.text();
      if (content.trim().length > 0) {
        completed.set(i, { index: i, planMd: content, sessionId: "" });
        recoveredFromDisk.push(i);
      }
    }
  }

  if (recoveredFromDisk.length > 0) {
    jobLog(job.id, `Recovered ${recoveredFromDisk.length} plan(s) from disk (indices: ${recoveredFromDisk.join(", ")})`);
    // Persist immediately so a future restart doesn't need to re-scan disk.
    await Promise.all(recoveredFromDisk.map(i => savePlanProgress(job.id, completed.get(i)!)));
  }

  const pending: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!completed.has(i)) pending.push(i);
  }

  if (pending.length === 0 && completed.size > 0) {
    jobLog(job.id, `All ${total} hardwork plan agents already completed in a previous run — skipping straight to synthesis`);
    await postInfo(job.id, `All ${total} plan agents already completed in a previous run — proceeding to synthesis...`);
  } else {
    if (completed.size > 0) {
      jobLog(job.id, `Resuming hardwork: ${completed.size}/${total} plan agent(s) already done, running remaining ${pending.length}`);
      await postInfo(job.id, `Resuming — ${completed.size}/${total} plan agents already done, running remaining ${pending.length}...`);
    } else {
      await postInfo(job.id, `Running ${total} parallel plan agents...`);
    }

    // Each parallel plan agent gets its own isolated opencode session
    // database. Running multiple `opencode run` processes concurrently
    // against the same project shares a single SQLite session DB, which
    // under contention can cause a process to hang silently (e.g. stuck
    // mid tool-call while writing session state for a `read`). Giving each
    // agent its own DB file avoids that contention entirely. These agents
    // are fire-and-forget (no later `--session --continue`), so isolation
    // is safe here.
    const tmpDir = os.tmpdir();
    const results = await Promise.allSettled(pending.map(async (i) => {
      const dbPath = path.join(tmpDir, `opencode-hardwork-${job.id}-${i}.db`);
      const result = await runPlanAgent(
        job, worktreePath, issueNumber, helperPath, `hardwork-${job.id}-${i}`, false,
        { OPENCODE_DB: dbPath },
      );
      const plan: IndividualPlan = { index: i, planMd: result.planMd, sessionId: result.sessionId };
      await savePlanProgress(job.id, plan);
      return plan;
    }));

    for (let idx = 0; idx < pending.length; idx++) {
      const i = pending[idx]!;
      const r = results[idx]!;
      if (r.status === "fulfilled") {
        completed.set(i, r.value);
      } else {
        jobLog(job.id, `Hardwork plan agent ${i} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }
  }

  if (completed.size === 0) {
    throw new Error("All parallel plan agents failed");
  }

  const successfulPlans = [...completed.values()].toSorted((a, b) => a.index - b.index);
  if (successfulPlans.length < total) {
    jobLog(job.id, `Proceeding to synthesis with ${successfulPlans.length}/${total} successful plan(s)`);
  }

  await postInfo(job.id, "Synthesizing plans into final plan...");

  const synthesisPlanFile = path.join(planDir, `plan-synthesis-${job.id}.md`);
  const synthesisPrompt = buildSynthesisPrompt(job, successfulPlans, issueNumber, synthesisPlanFile);

  const synthesisResult = await runOpencodeStreaming(
    job.id,
    worktreePath,
    synthesisPlanFile,
    ["opencode", "run", "--agent", "plan", "--dir", worktreePath, synthesisPrompt],
  );

  const plans = [
    ...successfulPlans.map((p, i) => ({
      index: i,
      planMd: p.planMd,
      label: `Plan ${i + 1}`,
    })),
    {
      index: successfulPlans.length,
      planMd: synthesisResult.planMd,
      label: "Synthesized Plan",
    },
  ];

  await client.hardworkPlansReady.mutate({
    jobId: job.id,
    plans,
    synthesizedPlanMd: synthesisResult.planMd,
    sessionId: synthesisResult.sessionId,
  });

  if (job.autoMode) {
    return { planMd: synthesisResult.planMd, sessionId: synthesisResult.sessionId };
  }

  return await waitForHardworkSelection(job.id);
}

export { runHardworkFlow, buildSynthesisPrompt, waitForHardworkSelection };

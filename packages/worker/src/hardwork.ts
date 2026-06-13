import path from "node:path";
import { WORKER_ID } from "./env";
import { client, postInfo } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { runPlanAgent } from "./plan";
import { runOpencodeStreaming } from "./opencode";

function buildSynthesisPrompt(
  job: Job,
  plans: { index: number; planMd: string }[],
  issueNumber: number | null,
): string {
  const issueRef = issueNumber ? ` The related GitHub issue is #${issueNumber}.` : "";

  const plansBlock = plans.map((p, i) =>
    `---\n## Plan ${i + 1}\n\n${p.planMd}\n`
  ).join("\n");

  return [
    `You are a senior architect evaluating ${plans.length} plans for a ${job.kind} task on ${job.repoSlug}.${issueRef}`,
    `Review each plan below, identify what's good and what's bad about each, then synthesize one final plan that extracts the best parts from all of them.`,
    `The final plan will be displayed in a full-featured Markdown viewer that supports Mermaid diagrams, LaTeX, code blocks, etc. Use these liberally.`,
    `The plan should cover: files to change, approach, and any risk areas.`,
    `\n\n## Plans to Evaluate\n\n${plansBlock}`,
    `\n\nWrite the synthesized plan to the plan file path. It must be a single, coherent implementation plan — not a comparison.`,
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

async function runHardworkFlow(
  job: Job,
  worktreePath: string,
  issueNumber: number | null,
  helperPath: string,
): Promise<{ planMd: string; sessionId: string } | null> {
  await postInfo(job.id, `Running ${job.parallelPlanCount} parallel plan agents...`);

  const planPromises = Array.from(
    { length: job.parallelPlanCount },
    (_, i) => runPlanAgent(job, worktreePath, issueNumber, helperPath, `hardwork-${job.id}-${i}`),
  );

  const results = await Promise.allSettled(planPromises);
  const successfulPlans = results
    .filter((r): r is PromiseFulfilledResult<{ planMd: string; sessionId: string }> => r.status === "fulfilled")
    .map((r, i) => ({ index: i, planMd: r.value.planMd, sessionId: r.value.sessionId }));

  if (successfulPlans.length === 0) {
    throw new Error("All parallel plan agents failed");
  }

  await postInfo(job.id, "Synthesizing plans into final plan...");

  const synthesisPrompt = buildSynthesisPrompt(job, successfulPlans, issueNumber);
  const planDir = path.join(worktreePath, ".opencode", "plans");
  const synthesisPlanFile = path.join(planDir, `plan-synthesis-${job.id}.md`);

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

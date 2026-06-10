import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "@opencode-discord/shared";

const {
  BOT_URL = "http://localhost:3000",
  SHARED_SECRET,
  WORKER_ID = "default",
  DRY_RUN,
} = process.env;

const dryRun = DRY_RUN === "true";

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function workerLog(...args: any[]) {
  console.log(`[Worker ${WORKER_ID} ${timestamp()}]`, ...args);
}

function jobLog(jobId: number, ...args: any[]) {
  console.log(`[Worker ${WORKER_ID} ${timestamp()}] [Job #${jobId}]`, ...args);
}

const client = createTRPCClient<AppRouter>({
  links: [
    httpLink({
      url: `${BOT_URL}/trpc`,
      headers: { Authorization: `Bearer ${SHARED_SECRET}` },
    }),
  ],
});

async function postDebug(jobId: number, message: string) {
  await client.postStatus.mutate({ jobId, message, level: "debug" }).catch(() => {});
}

async function postInfo(jobId: number, message: string) {
  await client.postStatus.mutate({ jobId, message, level: "info" }).catch(() => {});
}

// Fetch the issue model from bot settings (no env variable per spec)
async function getIssueModel(): Promise<string> {
  try {
    const result = await client.getSetting.query({ key: "issue_model" });
    return result.value ?? "opencode/big-pickle";
  } catch {
    return "opencode/big-pickle";
  }
}

let activeJobId: number | null = null;

async function poll(): Promise<void> {
  if (activeJobId !== null) {
    workerLog(`Skipping poll — job #${activeJobId} still active`);
    return;
  }
  const start = performance.now();
  const result = await client.pollNextJob.query({ workerId: WORKER_ID });
  if (result) {
    const elapsed = (performance.now() - start).toFixed(0);
    workerLog(`Claimed job #${result.id} for repo ${result.repoSlug} (poll took ${elapsed}ms)`);
    activeJobId = result.id;
    await handleJob(result);
  }
}

async function heartbeat() {
  try {
    const start = performance.now();
    await client.getJobStatus.query({ jobId: 0, workerId: WORKER_ID });
    workerLog(`Heartbeat OK (${(performance.now() - start).toFixed(0)}ms)`);
  } catch {
    // getJobStatus returns null for missing jobs — heartbeat still recorded
  }
}

type Job = NonNullable<Awaited<ReturnType<typeof client.pollNextJob.query>>>;

async function handleJob(job: Job) {
  const repoPath = job.repoPath;
  if (!repoPath) {
    jobLog(job.id, `Repository path for ${job.repoSlug} not found — cancelling`);
    await client.postStatus.mutate({
      jobId: job.id,
      message: `Repository path for \`${job.repoSlug}\` not found`,
      level: "error",
    });
    await client.cancelJob.mutate({ jobId: job.id });
    activeJobId = null;
    return;
  }

  jobLog(job.id, `Starting job for ${job.repoSlug} at ${repoPath} (kind: ${job.kind}, auto: ${job.autoMode}, dryRun: ${dryRun})`);
  if (job.issueNumber) jobLog(job.id, `Pre-existing issue #${job.issueNumber}`);
  if (job.context) jobLog(job.id, `Context length: ${job.context.length} chars`);

  const jobStart = performance.now();

  try {
    // ── Step 1: Create worktree ────────────────────────────────────────────
    jobLog(job.id, "Step 1/5: Creating worktree...");
    await postInfo(job.id, "Creating worktree...");

    const branch = `report-${job.id}-${Date.now().toString(36)}`;
    jobLog(job.id, `Branch: ${branch}`);

    const stepStart = performance.now();
    const worktreePath = await createWorktree(repoPath, branch, job.id);
    jobLog(job.id, `Worktree created at ${worktreePath} (${(performance.now() - stepStart).toFixed(0)}ms)`);

    if (!dryRun) {
      await postDebug(job.id, `Worktree: \`${worktreePath}\` on branch \`${branch}\``);
    }

    // ── Step 2: Use pre-generated issue or generate one ────────────────────
    let issueNumber = job.issueNumber;

    if (!issueNumber) {
      jobLog(job.id, "Step 2/5: Generating GitHub issue...");
      await postInfo(job.id, "Generating GitHub issue...");

      const stepStart = performance.now();
      issueNumber = await generateIssue(job, repoPath);
      jobLog(job.id, `Issue generation completed in ${(performance.now() - stepStart).toFixed(0)}ms, issue #${issueNumber ?? "N/A"}`);

      if (issueNumber !== null) {
        await client.setIssueNumber.mutate({ jobId: job.id, issueNumber }).catch(() => {});
        const repoNameWithOwner = dryRun ? "" : await getRepoNameWithOwner(repoPath);
        const issueUrl = repoNameWithOwner
          ? `https://github.com/${repoNameWithOwner}/issues/${issueNumber}`
          : `issue #${issueNumber}`;
        jobLog(job.id, `Issue URL: ${issueUrl}`);
        await client.postStatus.mutate({
          jobId: job.id,
          message: `Issue created: ${issueUrl}`,
          level: "success",
        });
      }
    }

    // ── Step 3: Plan agent ─────────────────────────────────────────────────
    jobLog(job.id, "Step 3/5: Running plan agent...");
    await postInfo(job.id, "Planning started — running opencode plan agent...");

    const planStart = performance.now();
    const { planMd, sessionId } = await runPlanAgent(job, worktreePath, issueNumber);
    jobLog(job.id, `Plan agent completed in ${(performance.now() - planStart).toFixed(0)}ms, session: ${sessionId}, plan length: ${planMd.length} chars`);

    await postInfo(job.id, "Planning complete, posting plan for review...");

    jobLog(job.id, `Posting plan to Discord thread via planReady...`);
    await client.planReady.mutate({ jobId: job.id, planMd, sessionId });
    jobLog(job.id, `Plan posted to Discord`);

    // ── Step 4: Approval loop ──────────────────────────────────────────────
    jobLog(job.id, "Step 4/5: Waiting for approval...");
    const finalSessionId = await waitForApproval(job.id, sessionId, worktreePath, job);
    if (finalSessionId === null) {
      jobLog(job.id, "Job was cancelled by user");
      await client.postStatus.mutate({
        jobId: job.id,
        message: "Job cancelled",
        level: "error",
      });
      cleanupWorktree(worktreePath).catch(() => {});
      activeJobId = null;
      return;
    }
    jobLog(job.id, `Approval received, session: ${finalSessionId}`);

    // ── Step 5: Build agent ────────────────────────────────────────────────
    jobLog(job.id, "Step 5/5: Starting build agent...");
    await postInfo(job.id, "Starting build agent...");

    const buildStart = performance.now();
    const prUrl = await runBuildAgent(job.id, worktreePath, issueNumber, branch);
    jobLog(job.id, `Build agent completed in ${(performance.now() - buildStart).toFixed(0)}ms`);

    if (prUrl) {
      jobLog(job.id, `PR created: ${prUrl}`);
      await client.postStatus.mutate({
        jobId: job.id,
        message: `PR created: ${prUrl}`,
        level: "success",
      });
      await client.postStatus.mutate({
        jobId: job.id,
        message: "Job complete! 🎉",
        level: "success",
      });
    } else {
      jobLog(job.id, `PR creation failed or returned no URL`);
    }

    cleanupWorktree(worktreePath).catch(() => {});
  } catch (err: any) {
    const elapsed = ((performance.now() - jobStart) / 1000).toFixed(1);
    jobLog(job.id, `Job FAILED after ${elapsed}s: ${err?.message ?? String(err)}`);
    if (err?.stack) jobLog(job.id, `Stack: ${err.stack}`);
    console.error(err);
    await client.postStatus.mutate({
      jobId: job.id,
      message: `Job failed: ${err?.message ?? String(err)}`,
      level: "error",
    });
  }

  const totalElapsed = ((performance.now() - jobStart) / 1000).toFixed(1);
  jobLog(job.id, `Job finished in ${totalElapsed}s`);
  activeJobId = null;
}

// ── Worktree helpers ─────────────────────────────────────────────────────────

async function createWorktree(repoPath: string, branch: string, jobId: number): Promise<string> {
  if (dryRun) {
    jobLog(jobId, `[DRY RUN] gwq add -b ${branch} (in ${repoPath})`);
    jobLog(jobId, `[DRY RUN] gwq get ${branch}`);
    jobLog(jobId, `[DRY RUN] Using repo path as worktree (no git worktree created)`);
    return repoPath;
  }
  jobLog(jobId, `Running: gwq add -b ${branch} (in ${repoPath})`);
  const addStart = performance.now();
  await execCommand("gwq", ["add", "-b", branch], repoPath, jobId);
  jobLog(jobId, `gwq add OK (${(performance.now() - addStart).toFixed(0)}ms)`);

  jobLog(jobId, `Running: gwq get ${branch}`);
  const getStart = performance.now();
  const worktreePath = (await execCommand("gwq", ["get", branch], repoPath, jobId)).trim();
  jobLog(jobId, `gwq get => ${worktreePath} (${(performance.now() - getStart).toFixed(0)}ms)`);
  return worktreePath;
}

async function cleanupWorktree(worktreePath: string) {
  try {
    jobLog(0, `Cleaning up worktree: ${worktreePath}`);
    await execCommand("gwq", ["remove", worktreePath], undefined, 0);
  } catch (err) {
    jobLog(0, "Worktree cleanup error:", err);
  }
}

async function getRepoNameWithOwner(repoPath: string): Promise<string> {
  try {
    const out = await execCommand(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      repoPath,
      0,
    );
    return out.trim();
  } catch {
    return "";
  }
}

// ── Issue generation ─────────────────────────────────────────────────────────

async function generateIssue(job: Job, repoPath: string): Promise<number | null> {
  try {
    const issueModel = await getIssueModel();
    jobLog(job.id, `Issue model: ${issueModel}`);
    jobLog(job.id, `Context available: ${!!job.context}, context length: ${job.context?.length ?? 0} chars`);

    const prompt = [
      `Create a well-structured GitHub issue for the following ${job.kind} report.`,
      `Repository: ${job.repoSlug}`,
      ``,
      `# Output ONLY:`,
      `Line 1: Issue title (plain text, no markdown heading prefix)`,
      `Line 2+: Issue body in Markdown`,
      ``,
      `## Report context:`,
      `Kind: ${job.kind}`,
      `Repo: ${job.repoSlug}`,
      ...(job.context ? [`\nDiscord thread context:\n${job.context}`] : []),
    ].join("\n");

    jobLog(job.id, `Issue prompt length: ${prompt.length} chars`);

    if (dryRun) {
      jobLog(job.id, `[DRY RUN] 🐛 Issue generation`);
      jobLog(job.id, `[DRY RUN] Model: ${issueModel}`);
      jobLog(job.id, `[DRY RUN] Would run: opencode run --model ${issueModel} --print ...`);
      jobLog(job.id, `[DRY RUN] Would run: gh issue create --title ... --body ...`);
      await postInfo(job.id, `[DRY RUN] Issue generation skipped — prompt logged to worker console`);
      return null;
    }

    const runStart = performance.now();
    jobLog(job.id, `Spawning: opencode run --model ${issueModel} --dir ${repoPath} [${prompt.length} chars]`);
    const proc = Bun.spawn(
      ["opencode", "run", "--model", issueModel, "--dir", repoPath, prompt],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );

    const [output, stderrContent] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    jobLog(job.id, `opencode issue gen finished: exit ${exitCode}, output ${output.length} chars (${(performance.now() - runStart).toFixed(0)}ms)`);

    if (exitCode !== 0) {
      jobLog(job.id, `Issue generation stderr: ${stderrContent.slice(0, 300)}`);
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Issue generation failed (exit ${exitCode}): ${stderrContent.slice(0, 300)}`,
        level: "error",
      });
      return null;
    }

    const lines = output.trim().split("\n");
    const title =
      lines[0]?.replace(/^#+\s*/, "").trim() || `[${job.repoSlug}] ${job.kind} report`;
    const body =
      lines.slice(1).join("\n").trim() ||
      `Automated ${job.kind} report for ${job.repoSlug}`;

    jobLog(job.id, `Issue title: ${title.slice(0, 80)}${title.length > 80 ? "..." : ""}`);
    jobLog(job.id, `Issue body length: ${body.length} chars`);

    const repoNameWithOwner = await getRepoNameWithOwner(repoPath);
    const ghArgs = [
      "issue", "create",
      "--title", title,
      "--body", body,
      ...(repoNameWithOwner ? ["--repo", repoNameWithOwner] : []),
    ];

    jobLog(job.id, `Spawning: gh ${ghArgs.join(" ")}`);
    const ghStart = performance.now();
    const ghProc = Bun.spawn(["gh", ...ghArgs], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const ghOutput = await new Response(ghProc.stdout).text();
    const ghExit = await ghProc.exited;
    jobLog(job.id, `gh issue create finished: exit ${ghExit}, output: ${ghOutput.trim()} (${(performance.now() - ghStart).toFixed(0)}ms)`);

    if (ghExit === 0) {
      const match = ghOutput.trim().match(/\/(\d+)$/);
      if (match && match[1]) {
        const num = parseInt(match[1]);
        jobLog(job.id, `Created issue #${num}: ${ghOutput.trim()}`);
        return num;
      }
    }

    jobLog(job.id, `gh issue create returned non-zero exit ${ghExit}`);
    return null;
  } catch (err) {
    jobLog(job.id, `Issue generation error:`, err);
    return null;
  }
}

// ── Plan agent ───────────────────────────────────────────────────────────────

async function runPlanAgent(
  job: Job,
  worktreePath: string,
  issueNumber: number | null,
): Promise<{ planMd: string; sessionId: string }> {
  const issueRef = issueNumber ? ` The related GitHub issue is #${issueNumber}.` : "";
  const contextBlock = job.context
    ? `\n\nThe following is the Discord report thread context with file attachments:\n${job.context}`
    : "";
  const prompt = [
    `You are a planning agent for a ${job.kind} task on repository ${job.repoSlug}.${issueRef}`,
    `Review the codebase and write a detailed implementation plan to PLAN.md at the root of this directory.`,
    `The plan should cover: files to change, approach, and any risk areas.`,
    contextBlock,
  ].filter(Boolean).join(" ");

  jobLog(job.id, `Plan agent prompt length: ${prompt.length} chars, issueRef: ${!!issueNumber}, contextBlock: ${!!job.context}`);

  if (dryRun) {
    jobLog(job.id, `[DRY RUN] 📋 Plan agent`);
    jobLog(job.id, `[DRY RUN] Prompt: ${prompt.slice(0, 200)}...`);
    jobLog(job.id, `[DRY RUN] Would run: opencode run --agent plan --print ...`);
    await postInfo(job.id, `[DRY RUN] Plan agent skipped — prompt logged to worker console`);
    return { planMd: "# DRY RUN — plan generation skipped", sessionId: `dry-run-${job.id}` };
  }

  jobLog(job.id, `Starting opencode plan agent in ${worktreePath}`);
  return runOpencodeStreaming(job.id, worktreePath, ["opencode", "run", "--agent", "plan", "--dir", worktreePath, prompt]);
}

async function runOpencodeStreaming(
  jobId: number,
  cwd: string,
  argv: string[],
  extraArgs: string[] = [],
): Promise<{ planMd: string; sessionId: string }> {
  jobLog(jobId, `Spawning: ${argv.join(" ")} ${extraArgs.join(" ")}`);

  const proc = Bun.spawn([...argv, ...extraArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let sessionId = "";
  let fullOutput = "";
  let lineCount = 0;

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const streamStart = performance.now();

  // Read stderr concurrently to prevent pipe buffer deadlock
  const stderrPromise = new Response(proc.stderr).text();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fullOutput += chunk;

      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lineCount++;

        const sessionMatch = trimmed.match(/\bsession[=:\s]+([a-zA-Z0-9_-]{8,})/i);
        if (sessionMatch && sessionMatch[1] && !sessionId) {
          sessionId = sessionMatch[1];
          jobLog(jobId, `Detected session ID: ${sessionId}`);
        }

        const isMeaningful =
          /^[▶✓✗►]/.test(trimmed) ||
          /^\[\d{2}:\d{2}/.test(trimmed) ||
          /^(Tool|Agent|Step|Writing|Reading|Running|Creating|Modifying|Analyzing|Planning|Building|Committing|Error)/.test(
            trimmed,
          );

        if (isMeaningful) {
          const clean = trimmed.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 300);
          await client.postStatus.mutate({ jobId, message: clean, level: "info" }).catch(() => {});
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const elapsed = (performance.now() - streamStart).toFixed(0);
  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
  jobLog(jobId, `opencode process finished: exit ${exitCode}, ${lineCount} lines in ${elapsed}ms`);

  if (exitCode !== 0) {
    jobLog(jobId, `opencode stderr: ${stderr.slice(0, 500)}`);
    throw new Error(`opencode failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  jobLog(jobId, `Reading PLAN.md from ${cwd}/PLAN.md`);
  const planMd = await Bun.file(`${cwd}/PLAN.md`).text().catch(() => {
    jobLog(jobId, `PLAN.md not found, using fullOutput fallback`);
    return "";
  });

  if (!sessionId) {
    const m = fullOutput.match(/\bsession[=:\s]+([a-zA-Z0-9_-]{8,})/i);
    if (m && m[1]) {
      sessionId = m[1];
      jobLog(jobId, `Session ID found via fallback scan: ${sessionId}`);
    }
  }

  return { planMd: planMd || fullOutput, sessionId: sessionId || `fallback-${jobId}` };
}

// ── Approval loop ────────────────────────────────────────────────────────────

async function waitForApproval(
  jobId: number,
  sessionId: string,
  worktreePath: string,
  job: Job,
): Promise<string | null> {
  let currentSession = sessionId;
  let pollCount = 0;

  jobLog(jobId, `Entering approval loop, polling every 2s`);
  await postDebug(jobId, `Waiting for plan approval...`);

  while (true) {
    await Bun.sleep(2000);
    pollCount++;

    let current: Awaited<ReturnType<typeof client.getJobStatus.query>>;
    try {
      current = await client.getJobStatus.query({ jobId, workerId: WORKER_ID });
    } catch (err) {
      jobLog(jobId, `Approval poll #${pollCount} failed (network error), retrying`);
      continue;
    }

    if (!current) {
      jobLog(jobId, `Approval poll #${pollCount}: job not found, returning null`);
      return null;
    }

    jobLog(jobId, `Approval poll #${pollCount}: status=${current.status}${current.pendingSuggestion ? `, suggestion="${current.pendingSuggestion}"` : ""}`);

    if (current.status === "approved") {
      jobLog(jobId, `Approved after ${pollCount} polls`);
      await postDebug(jobId, `Plan approved after ${pollCount * 2}s`);
      return currentSession;
    }
    if (current.status === "cancelled") {
      jobLog(jobId, `Cancelled after ${pollCount} polls`);
      return null;
    }

    if (current.status === "planning" && current.pendingSuggestion) {
      const suggestion = current.pendingSuggestion;
      jobLog(jobId, `Revising plan with suggestion: "${suggestion}"`);

      // Acknowledge so we don't re-process the same suggestion
      await client.ackSuggestion.mutate({ jobId }).catch(() => {});

      await client.postStatus.mutate({
        jobId,
        message: `Revising plan: "${suggestion}"`,
        level: "info",
      });

      // Resume opencode session with suggestion
      jobLog(jobId, `Resuming opencode session ${currentSession} with suggestion`);
      const reviseStart = performance.now();
      const { planMd: newPlan, sessionId: newSession } = await runOpencodeStreaming(
        jobId,
        worktreePath,
        [
          "opencode", "run",
          "--agent", "plan",
          "--session", currentSession,
          "--continue",
          "--dir", worktreePath,
          suggestion,
        ],
      );
      jobLog(jobId, `Plan revision completed in ${(performance.now() - reviseStart).toFixed(0)}ms, new session: ${newSession}`);

      currentSession = newSession || currentSession;

      await postInfo(jobId, "Plan revised, posting updated plan for review...");

      jobLog(jobId, `Posting revised plan via planReady`);
      await client.planReady.mutate({
        jobId,
        planMd: newPlan,
        sessionId: currentSession,
      });

      // Loop continues — wait for next approval/cancel/suggest
    }
    // If status is still "plan_ready" or anything else, keep polling
  }
}

// ── Build agent ──────────────────────────────────────────────────────────────

async function runBuildAgent(
  jobId: number,
  worktreePath: string,
  issueNumber: number | null,
  branch: string,
): Promise<string | null> {
  const issueRef = issueNumber
    ? `The related GitHub issue is #${issueNumber} — make sure the PR body contains "Closes #${issueNumber}".`
    : "";

  const prompt = [
    `Follow the plan in PLAN.md exactly to implement the required changes.`,
    issueRef,
    `When done, commit all changes with a clear message, push the branch, then create a pull request.`,
  ]
    .filter(Boolean)
    .join(" ");

  jobLog(jobId, `Build prompt: ${prompt.length} chars, issueRef: ${!!issueNumber}`);

  if (dryRun) {
    jobLog(jobId, `[DRY RUN] 🔧 Build agent`);
    jobLog(jobId, `[DRY RUN] Prompt: ${prompt}`);
    jobLog(jobId, `[DRY RUN] Would run: opencode run --agent build --print ...`);
    jobLog(jobId, `[DRY RUN] Would run: gh pr create --title "${branch.replace(/-/g, " ")} implementation" --body ...`);
    await postInfo(jobId, `[DRY RUN] Build agent skipped — prompt logged to worker console`);
    return null;
  }

  jobLog(jobId, `Starting opencode build agent in ${worktreePath}`);
  const buildStart = performance.now();
  await runOpencodeStreaming(jobId, worktreePath, [
    "opencode", "run", "--agent", "build", "--dir", worktreePath, prompt,
  ]);
  jobLog(jobId, `Build agent finished in ${(performance.now() - buildStart).toFixed(0)}ms`);

  // Create the PR via gh CLI
  const prBody = issueNumber
    ? `Closes #${issueNumber}\n\nImplemented according to PLAN.md.`
    : "Implemented according to PLAN.md.";

  const prTitle = `${branch.replace(/-/g, " ")} implementation`;

  jobLog(jobId, `Creating PR: gh pr create --title "${prTitle}" --body [${prBody.length} chars]`);
  const prStart = performance.now();
  const prProc = Bun.spawn(
    ["gh", "pr", "create", "--title", prTitle, "--body", prBody],
    { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
  );

  const [prOutput, prErrContent] = await Promise.all([
    new Response(prProc.stdout).text(),
    new Response(prProc.stderr).text(),
  ]);
  const prExit = await prProc.exited;
  jobLog(jobId, `gh pr create: exit ${prExit}, output: ${prOutput.trim()} (${(performance.now() - prStart).toFixed(0)}ms)`);

  if (prExit !== 0) {
    jobLog(jobId, `PR creation stderr: ${prErrContent.slice(0, 400)}`);
    await client.postStatus.mutate({
      jobId,
      message: `PR creation failed: ${prErrContent.slice(0, 400)}`,
      level: "error",
    });
    return null;
  }

  jobLog(jobId, `PR URL: ${prOutput.trim()}`);
  return prOutput.trim();
}

// ── Utilities ────────────────────────────────────────────────────────────────

async function execCommand(cmd: string, args: string[], cwd?: string, jobId?: number): Promise<string> {
  const jId = jobId ?? 0;
  jobLog(jId, `exec: ${cmd} ${args.join(" ")}${cwd ? ` (in ${cwd})` : ""}`);

  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code === 0) {
    jobLog(jId, `${cmd} OK (${stdout.length} bytes stdout)`);
    return stdout;
  }

  jobLog(jId, `${cmd} FAILED (exit ${code}): ${stderr.slice(0, 200)}`);
  throw new Error(`${cmd} failed (exit ${code}): ${stderr}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  Worker ${WORKER_ID.padEnd(10)}                 ║`);
  console.log(`║  Polling: ${BOT_URL}/trpc          ║`);
  console.log(`║  Interval: 5s (backoff: up to 60s)          ║`);
  console.log(`║  Heartbeat: 30s                              ║`);
  console.log(`║  Mode: ${dryRun ? "🧪 DRY RUN" : "🔧 LIVE".padEnd(23)}           ║`);
  console.log(`╚══════════════════════════════════════════════╝`);

  // Heartbeat every 30s
  setInterval(() => {
    heartbeat().catch(err => workerLog("Heartbeat error:", err));
  }, 30_000);

  // Poll with exponential backoff on error (5s base, max 60s)
  let pollInterval = 5_000;
  const scheduleNextPoll = () => {
    setTimeout(() => {
      poll().then(success => {
        pollInterval = 5_000;
        scheduleNextPoll();
      }).catch(err => {
        workerLog(`Poll error (will retry in ${pollInterval / 1000}s):`, err);
        pollInterval = Math.min(pollInterval * 2, 60_000);
        scheduleNextPoll();
      });
    }, pollInterval);
  };
  scheduleNextPoll();
}

main().catch(console.error);

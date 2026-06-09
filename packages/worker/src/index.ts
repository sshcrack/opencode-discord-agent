import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "@opencode-discord/shared";
import { readFile } from "fs/promises";

const {
  BOT_URL = "http://localhost:3000",
  SHARED_SECRET,
  WORKER_ID = "default",
  DRY_RUN,
} = process.env;

const dryRun = DRY_RUN === "true";

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

const client = createTRPCClient<AppRouter>({
  links: [
    httpLink({
      url: `${BOT_URL}/trpc`,
      headers: { Authorization: `Bearer ${SHARED_SECRET}` },
    }),
  ],
});

// Fetch the issue model from bot settings (no env variable per spec)
async function getIssueModel(): Promise<string> {
  try {
    const result = await client.getSetting.query({ key: "issue_model" });
    return result.value ?? "opencode/big-pickle";
  } catch {
    return "opencode/big-pickle";
  }
}

async function poll() {
  try {
    const result = await client.pollNextJob.query({ workerId: WORKER_ID });
    if (result) {
      console.log(`Claimed job #${result.id} for repo ${result.repoSlug}`);
      // Run async — intentionally not awaited so we don't block the poll interval
      handleJob(result).catch(err =>
        console.error(`Unhandled job error for #${result.id}:`, err),
      );
    }
  } catch (err) {
    console.error("Poll error:", err);
  }
}

async function heartbeat() {
  try {
    // Use getJobStatus with a dummy job id just to update lastSeen. 
    // Actually we send pollNextJob — but that could claim a job unintentionally
    // if two calls overlap. Instead we rely on getJobStatus with id=0 which
    // won't match anything but will update the heartbeat via workerId.
    await client.getJobStatus.query({ jobId: 0, workerId: WORKER_ID });
  } catch {
    // getJobStatus returns null for missing jobs — heartbeat still recorded
  }
}

type Job = NonNullable<Awaited<ReturnType<typeof client.pollNextJob.query>>>;

async function handleJob(job: Job) {
  const repoPath = job.repoPath;
  if (!repoPath) {
    await client.postStatus.mutate({
      jobId: job.id,
      message: `Repository path for \`${job.repoSlug}\` not found`,
      level: "error",
    });
    await client.cancelJob.mutate({ jobId: job.id });
    return;
  }

  try {
    // ── Step 1: Create worktree ────────────────────────────────────────────
    await client.postStatus.mutate({
      jobId: job.id,
      message: "Creating worktree...",
      level: "info",
    });

    const branch = `report-${job.id}-${Date.now().toString(36)}`;
    const worktreePath = await createWorktree(repoPath, branch, job.id);

    if (!dryRun) {
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Worktree created at \`${worktreePath}\` on branch \`${branch}\``,
        level: "info",
      });
    }

    // ── Step 2: Use pre-generated issue or generate one ────────────────────
    let issueNumber = job.issueNumber;

    if (!issueNumber) {
      await client.postStatus.mutate({
        jobId: job.id,
        message: "Generating GitHub issue...",
        level: "info",
      });

      issueNumber = await generateIssue(job, repoPath);

      if (issueNumber !== null) {
        const repoNameWithOwner = dryRun ? "" : await getRepoNameWithOwner(repoPath);
        const issueUrl = repoNameWithOwner
          ? `https://github.com/${repoNameWithOwner}/issues/${issueNumber}`
          : `issue #${issueNumber}`;
        await client.postStatus.mutate({
          jobId: job.id,
          message: `Issue created: ${issueUrl}`,
          level: "success",
        });
      }
    }

    // ── Step 3: Plan agent ─────────────────────────────────────────────────
    await client.postStatus.mutate({
      jobId: job.id,
      message: "Planning started — running opencode plan agent...",
      level: "info",
    });

    const { planMd, sessionId } = await runPlanAgent(job, worktreePath, issueNumber);

    await client.postStatus.mutate({
      jobId: job.id,
      message: "Planning complete, posting plan for review...",
      level: "info",
    });

    await client.planReady.mutate({ jobId: job.id, planMd, sessionId });

    // ── Step 4: Approval loop ──────────────────────────────────────────────
    const finalSessionId = await waitForApproval(job.id, sessionId, worktreePath, job);
    if (finalSessionId === null) {
      await client.postStatus.mutate({
        jobId: job.id,
        message: "Job cancelled",
        level: "error",
      });
      cleanupWorktree(worktreePath).catch(() => {});
      return;
    }

    // ── Step 5: Build agent ────────────────────────────────────────────────
    await client.postStatus.mutate({
      jobId: job.id,
      message: "Starting build agent...",
      level: "info",
    });

    const prUrl = await runBuildAgent(job.id, worktreePath, issueNumber, branch);

    if (prUrl) {
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
    }

    cleanupWorktree(worktreePath).catch(() => {});
  } catch (err: any) {
    console.error("Job error:", err);
    await client.postStatus.mutate({
      jobId: job.id,
      message: `Job failed: ${err?.message ?? String(err)}`,
      level: "error",
    });
  }
}

// ── Worktree helpers ─────────────────────────────────────────────────────────

async function createWorktree(repoPath: string, branch: string, jobId: number): Promise<string> {
  if (dryRun) {
    console.log(`[DRY RUN] gwq add -b ${branch}  (in ${repoPath})`);
    console.log(`[DRY RUN] gwq get ${branch}`);
    console.log(`[DRY RUN] Using repo path as worktree (no git worktree created)`);
    return repoPath;
  }
  await execCommand("gwq", ["add", "-b", branch], repoPath);
  const worktreePath = (await execCommand("gwq", ["get", branch], repoPath)).trim();
  return worktreePath;
}

async function cleanupWorktree(worktreePath: string) {
  try {
    await execCommand("gwq", ["remove", worktreePath]);
  } catch (err) {
    console.error("Worktree cleanup error:", err);
  }
}

async function getRepoNameWithOwner(repoPath: string): Promise<string> {
  try {
    const out = await execCommand(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      repoPath,
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

    if (dryRun) {
      console.log(`[DRY RUN] Job #${job.id} — 🐛 Issue generation`);
      console.log(`[DRY RUN] Model: ${issueModel}`);
      console.log("[DRY RUN] Prompt:");
      console.log(prompt);
      console.log("[DRY RUN] Would run: opencode run --model", issueModel, "--print ...");
      console.log("[DRY RUN] Would run: gh issue create --title ... --body ...");
      await client.postStatus.mutate({
        jobId: job.id,
        message: `[DRY RUN] Issue generation skipped — prompt logged to worker console`,
        level: "info",
      });
      return null;
    }

    const proc = Bun.spawn(
      ["opencode", "run", "--model", issueModel, "--print", prompt],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Issue generation failed (exit ${exitCode}): ${stderr.slice(0, 300)}`,
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

    const repoNameWithOwner = await getRepoNameWithOwner(repoPath);
    const ghArgs = [
      "issue", "create",
      "--title", title,
      "--body", body,
      ...(repoNameWithOwner ? ["--repo", repoNameWithOwner] : []),
    ];

    const ghProc = Bun.spawn(["gh", ...ghArgs], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const ghOutput = await new Response(ghProc.stdout).text();
    const ghExit = await ghProc.exited;

    if (ghExit === 0) {
      const match = ghOutput.trim().match(/\/(\d+)$/);
      if (match && match[1]) return parseInt(match[1]);
    }

    return null;
  } catch (err) {
    console.error("Issue generation error:", err);
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

  if (dryRun) {
    console.log(`[DRY RUN] Job #${job.id} — 📋 Plan agent`);
    console.log("[DRY RUN] Prompt:");
    console.log(prompt);
    console.log("[DRY RUN] Would run: opencode run --agent plan --print ...");
    await client.postStatus.mutate({
      jobId: job.id,
      message: `[DRY RUN] Plan agent skipped — prompt logged to worker console`,
      level: "info",
    });
    return { planMd: "# DRY RUN — plan generation skipped", sessionId: `dry-run-${job.id}` };
  }

  return runOpencodeStreaming(job.id, worktreePath, ["opencode", "run", "--agent", "plan", "--print", prompt]);
}

async function runOpencodeStreaming(
  jobId: number,
  cwd: string,
  argv: string[],
  extraArgs: string[] = [],
): Promise<{ planMd: string; sessionId: string }> {
  const proc = Bun.spawn([...argv, ...extraArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let sessionId = "";
  let fullOutput = "";

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fullOutput += chunk;

      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Extract session ID from opencode output (format: "session: <id>" or "session=<id>")
        const sessionMatch = trimmed.match(/\bsession[=:\s]+([a-zA-Z0-9_-]{8,})/i);
        if (sessionMatch && sessionMatch[1] && !sessionId) sessionId = sessionMatch[1];

        // Post meaningful lines: tool calls, agent steps, file writes, etc.
        // opencode typically prefixes meaningful lines with ▶, ✓, ✗, or timestamps
        const isMeaningful =
          /^[▶✓✗►]/.test(trimmed) ||
          /^\[\d{2}:\d{2}/.test(trimmed) ||
          /^(Tool|Agent|Step|Writing|Reading|Running|Creating|Modifying|Analyzing|Planning|Building|Committing|Error)/.test(
            trimmed,
          );

        if (isMeaningful) {
          // Strip ANSI codes
          const clean = trimmed.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 300);
          await client.postStatus.mutate({ jobId, message: clean, level: "info" }).catch(() => {});
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`opencode failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  const planMd = await readFile(`${cwd}/PLAN.md`, "utf-8").catch(() => "");

  // Fallback: scan full output for session ID
  if (!sessionId) {
    const m = fullOutput.match(/\bsession[=:\s]+([a-zA-Z0-9_-]{8,})/i);
    if (m && m[1]) sessionId = m[1];
  }

  return { planMd: planMd || fullOutput, sessionId: sessionId || `fallback-${jobId}` };
}

// ── Approval loop ────────────────────────────────────────────────────────────

/**
 * Polls job status until approved or cancelled.
 * If the user requests changes (status = "planning"), resumes opencode with
 * the suggestion and calls planReady again.
 *
 * Returns the final sessionId to use for the build, or null if cancelled.
 */
async function waitForApproval(
  jobId: number,
  sessionId: string,
  worktreePath: string,
  job: Job,
): Promise<string | null> {
  let currentSession = sessionId;

  while (true) {
    await Bun.sleep(2000);

    let current: Awaited<ReturnType<typeof client.getJobStatus.query>>;
    try {
      current = await client.getJobStatus.query({ jobId, workerId: WORKER_ID });
    } catch {
      continue;
    }

    if (!current) return null;

    if (current.status === "approved") return currentSession;
    if (current.status === "cancelled") return null;

    if (current.status === "planning" && current.pendingSuggestion) {
      const suggestion = current.pendingSuggestion;

      // Acknowledge so we don't re-process the same suggestion
      await client.ackSuggestion.mutate({ jobId }).catch(() => {});

      await client.postStatus.mutate({
        jobId,
        message: `Revising plan: "${suggestion}"`,
        level: "info",
      });

      // Resume opencode session with suggestion
      const { planMd: newPlan, sessionId: newSession } = await runOpencodeStreaming(
        jobId,
        worktreePath,
        [
          "opencode", "run",
          "--agent", "plan",
          "--session", currentSession,
          "--continue",
          "--print", suggestion,
        ],
      );

      currentSession = newSession || currentSession;

      await client.postStatus.mutate({
        jobId,
        message: "Plan revised, posting updated plan for review...",
        level: "info",
      });

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

  if (dryRun) {
    console.log(`[DRY RUN] Job #${jobId} — 🔧 Build agent`);
    console.log("[DRY RUN] Prompt:");
    console.log(prompt);
    console.log("[DRY RUN] Would run: opencode run --agent build --print ...");
    console.log(`[DRY RUN] Would run: gh pr create --title "${branch.replace(/-/g, " ")} implementation" --body ...`);
    await client.postStatus.mutate({
      jobId,
      message: `[DRY RUN] Build agent skipped — prompt logged to worker console`,
      level: "info",
    });
    return null;
  }

  await runOpencodeStreaming(jobId, worktreePath, [
    "opencode", "run", "--agent", "build", "--print", prompt,
  ]);

  // Create the PR via gh CLI
  const prBody = issueNumber
    ? `Closes #${issueNumber}\n\nImplemented according to PLAN.md.`
    : "Implemented according to PLAN.md.";

  const prTitle = `${branch.replace(/-/g, " ")} implementation`;

  const prProc = Bun.spawn(
    ["gh", "pr", "create", "--title", prTitle, "--body", prBody],
    { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
  );

  const prOutput = await new Response(prProc.stdout).text();
  const prExit = await prProc.exited;

  if (prExit !== 0) {
    const prErr = await new Response(prProc.stderr).text();
    await client.postStatus.mutate({
      jobId,
      message: `PR creation failed: ${prErr.slice(0, 400)}`,
      level: "error",
    });
    return null;
  }

  return prOutput.trim();
}

// ── Utilities ────────────────────────────────────────────────────────────────

function execCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn([cmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} failed (exit ${code}): ${stderr}`));
    });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Worker ${WORKER_ID} starting, polling ${BOT_URL}/trpc every 5s`);
  if (dryRun) console.log("🧪 DRY RUN MODE — no external commands will be executed");

  // Heartbeat every 30s
  setInterval(() => {
    heartbeat().catch(err => console.error("Heartbeat error:", err));
  }, 30_000);

  // Poll every 5s — but only claim one job at a time (handleJob is async and
  // starts processing immediately; if we've already claimed one the next poll
  // won't find any pending jobs, which is intentional).
  setInterval(() => {
    poll().catch(err => console.error("Poll error:", err));
  }, 5_000);
}

main().catch(console.error);

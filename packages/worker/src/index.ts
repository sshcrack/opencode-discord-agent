import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "@opencode-discord/shared";

const {
  BOT_URL = "http://localhost:3000",
  SHARED_SECRET,
  WORKER_ID = "default",
  DRY_RUN,
  SKIP_PERMISSIONS = "true",
} = process.env;

const dryRun = DRY_RUN === "true";
const skipPermissions = SKIP_PERMISSIONS === "true";
const skipPermissionsArg = skipPermissions ? ["--dangerously-skip-permissions"] : [];

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
let typingInterval: Timer | null = null;

function startTyping(threadId: string, jobId: number) {
  stopTyping();
  typingInterval = setInterval(async () => {
    await client.typing.mutate({ jobId, threadId }).catch(() => {});
  }, 8_000);
  // Fire immediately for initial indicator
  client.typing.mutate({ jobId, threadId }).catch(() => {});
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
}

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

  if (Bun.spawnSync(["test", "-d", repoPath]).exitCode !== 0) {
    jobLog(job.id, `Repository path ${repoPath} does not exist on worker — cancelling`);
    await client.postStatus.mutate({
      jobId: job.id,
      message: `Repository path \`${repoPath}\` does not exist on worker filesystem`,
      level: "error",
    });
    await client.cancelJob.mutate({ jobId: job.id });
    activeJobId = null;
    return;
  }

  jobLog(job.id, `Starting job for ${job.repoSlug} at ${repoPath} (kind: ${job.kind}, auto: ${job.autoMode}, dryRun: ${dryRun})`);
  if (job.issueNumber) jobLog(job.id, `Pre-existing issue #${job.issueNumber}`);
  if (job.context) jobLog(job.id, `Context length: ${job.context.length} chars`);

  startTyping(job.threadId, job.id);

  const jobStart = performance.now();
  let helperPath = "";

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

    // Create Discord helper script for agent use
    helperPath = `/tmp/opencode-discord-${job.id}.sh`;
    const helperLines: string[] = [
      '#!/bin/bash',
      '',
      `BOT_URL="${BOT_URL}"`,
      `TOKEN="${SHARED_SECRET}"`,
      `JOB_ID=${job.id}`,
      '',
      'if [ "$1" = "--rename" ]; then',
      '  shift',
      '  NAME="$*"',
      '  curl -s -X POST "$BOT_URL/trpc/renameJobThread" \\',
      '    -H "Authorization: Bearer $TOKEN" \\',
      '    -H "Content-Type: application/json" \\',
      "    -d '{\"0\":{\"jobId\":'\"$JOB_ID\"',\"name\":\"'\"$NAME\"'\"}}' > /dev/null",
      'else',
      '  curl -s -X POST "$BOT_URL/trpc/postStatus" \\',
      '    -H "Authorization: Bearer $TOKEN" \\',
      '    -H "Content-Type: application/json" \\',
      "    -d '{\"0\":{\"jobId\":'\"$JOB_ID\"',\"message\":\"'\"$1\"'\",\"level\":\"'\"${2:-info}\"'\"}}' > /dev/null",
      'fi',
    ];
    await Bun.write(helperPath, helperLines.join('\n'));
    Bun.spawnSync(["chmod", "700", helperPath]);
    jobLog(job.id, `Discord helper created at ${helperPath}`);

    // ── Step 2: Use pre-generated issue or generate one ────────────────────
    let issueNumber = job.issueNumber;

    if (!issueNumber) {
      jobLog(job.id, "Step 2/5: Generating GitHub issue...");
      await postInfo(job.id, "Generating GitHub issue...");

      const stepStart = performance.now();
      const { issueNumber: genIssueNumber, issueTitle } = await generateIssue(job, repoPath);
      issueNumber = genIssueNumber;
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
        // Rename thread to "#{issueNumber} {title}"
        const threadName = `#${issueNumber} ${issueTitle.replace(/^#+\s*/, "").trim()}`.slice(0, 100);
        await client.renameJobThread.mutate({ jobId: job.id, name: threadName }).catch(() => {});
      }
    }

    // Rename thread for pre-existing issues (was never renamed at creation)
    if (issueNumber && job.issueNumber) {
      jobLog(job.id, `Renaming thread for pre-existing issue #${issueNumber}...`);
      if (dryRun) {
        jobLog(job.id, `[DRY RUN] Would rename thread to #${issueNumber} {title}`);
      } else {
        const repoName = await getRepoNameWithOwner(repoPath);
        if (repoName) {
          const ghProc = Bun.spawn(["gh", "issue", "view", String(issueNumber), "--repo", repoName, "--json", "title", "--jq", ".title"], {
            cwd: repoPath,
            stdout: "pipe",
            stderr: "pipe",
          });
          const title = (await new Response(ghProc.stdout).text()).trim();
          const exitCode = await ghProc.exited;
          if (title && exitCode === 0) {
            const threadName = `#${issueNumber} ${title.replace(/^#+\s*/, "").trim()}`.slice(0, 100);
            await client.renameJobThread.mutate({ jobId: job.id, name: threadName }).catch(() => {});
            jobLog(job.id, `Thread renamed to: ${threadName}`);
          }
        }
      }
    }

    // ── Step 3: Plan agent ─────────────────────────────────────────────────
    jobLog(job.id, "Step 3/5: Running plan agent...");
    await postInfo(job.id, "Planning started — running opencode plan agent...");

    const planStart = performance.now();
    const { planMd, sessionId } = await runPlanAgent(job, worktreePath, issueNumber, helperPath);
    jobLog(job.id, `Plan agent completed in ${(performance.now() - planStart).toFixed(0)}ms, session: ${sessionId}, plan length: ${planMd.length} chars`);

    await postInfo(job.id, "Planning complete, posting plan for review...");

    jobLog(job.id, `Posting plan to Discord thread via planReady...`);
    await client.planReady.mutate({ jobId: job.id, planMd, sessionId });
    jobLog(job.id, `Plan posted to Discord`);

    // ── Step 4: Approval loop ──────────────────────────────────────────────
    jobLog(job.id, "Step 4/5: Waiting for approval...");
    const finalSessionId = await waitForApproval(job.id, sessionId, worktreePath, job, helperPath);
    if (finalSessionId === null) {
      jobLog(job.id, "Job was cancelled by user");
      // Close the GitHub issue since the plan was rejected
      if (issueNumber && !dryRun) {
        const repoName = await getRepoNameWithOwner(repoPath).catch(() => "");
        if (repoName) {
          const closeArgs = ["issue", "close", String(issueNumber), "--repo", repoName];
          jobLog(job.id, `Closing issue #${issueNumber}: gh ${closeArgs.join(" ")}`);
          const closeProc = Bun.spawn(["gh", ...closeArgs], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
          await closeProc.exited;
        }
      }
      await client.postStatus.mutate({
        jobId: job.id,
        message: "Job cancelled",
        level: "error",
      });
      stopTyping();
      cleanupWorktree(repoPath, branch).catch(() => {});
      Bun.spawnSync(["rm", "-f", helperPath]);
      activeJobId = null;
      return;
    }
    jobLog(job.id, `Approval received, session: ${finalSessionId}`);

    // ── Step 5: Build agent ────────────────────────────────────────────────
    jobLog(job.id, "Step 5/5: Starting build agent...");
    await postInfo(job.id, "Starting build agent...");

    const buildStart = performance.now();
    const prUrl = await runBuildAgent(job.id, worktreePath, issueNumber, branch, helperPath);
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
      await client.postStatus.mutate({
        jobId: job.id,
        message: `<@${job.reporterId}> your PR is ready!`,
        level: "info",
      });
    } else {
      jobLog(job.id, `PR creation failed or returned no URL`);
    }

    stopTyping();
    cleanupWorktree(repoPath, branch).catch(() => {});
  } catch (err: any) {
    const elapsed = ((performance.now() - jobStart) / 1000).toFixed(1);
    jobLog(job.id, `Job FAILED after ${elapsed}s: ${err?.message ?? String(err)}`);
    if (err?.stack) jobLog(job.id, `Stack: ${err.stack}`);
    console.error(err);
    stopTyping();
    if (helperPath) Bun.spawnSync(["rm", "-f", helperPath]);
    await client.postStatus.mutate({
      jobId: job.id,
      message: `Job failed: ${err?.message ?? String(err)}`,
      level: "error",
    });
  }

  const totalElapsed = ((performance.now() - jobStart) / 1000).toFixed(1);
  jobLog(job.id, `Job finished in ${totalElapsed}s`);
  stopTyping();
  Bun.spawnSync(["rm", "-f", helperPath]);
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

async function cleanupWorktree(repoPath: string, branch: string) {
  if (dryRun) return;
  try {
    jobLog(0, `Cleaning up worktree for branch ${branch}`);
    await execCommand("gwq", ["remove", "-f", branch], repoPath, 0);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes("no removable worktrees found")) {
      jobLog(0, `No worktree to remove for ${branch} (already clean)`);
    } else {
      jobLog(0, "Worktree cleanup error:", msg);
    }
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

async function generateIssue(job: Job, repoPath: string): Promise<{ issueNumber: number | null; issueTitle: string }> {
  try {
    const issueModel = await getIssueModel();
    jobLog(job.id, `Issue model: ${issueModel}`);
    jobLog(job.id, `Context available: ${!!job.context}, context length: ${job.context?.length ?? 0} chars`);

    const prompt = [
      `Create a well-structured GitHub issue for the following ${job.kind} report.`,
      `Repository: ${job.repoSlug}`,
      ``,
      `# CRITICAL — Output format:`,
      `Wrap your issue in <issue> tags. Everything outside the tags is ignored.`,
      `<issue>`,
      `  <title>The issue title here</title>`,
      `  <description>`,
      `    The issue body in Markdown (can be multiple lines).`,
      `  </description>`,
      `</issue>`,
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
      return { issueNumber: null, issueTitle: "" };
    }

    const runStart = performance.now();
    jobLog(job.id, `Spawning: opencode run --model ${issueModel} --dir ${repoPath} --format json [${prompt.length} chars]`);

    const proc = Bun.spawn(
      ["opencode", "run", "--model", issueModel, "--dir", repoPath, prompt, "--format", "json", ...skipPermissionsArg],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );

    // Stream JSON events for live Discord updates
    let issueText = "";
    let eventCount = 0;
    let buf = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const stderrPromise = new Response(proc.stderr).text();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          eventCount++;
          let event: any;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }
          // Handle events for live Discord updates
          const result = handleJsonEvent(event, job.id, repoPath);
          if (result) {
            await client.postStatus
              .mutate({ jobId: job.id, message: result.message, level: result.level, append: result.append })
              .catch(() => {});
          }
          // Accumulate text for issue extraction
          if (event.type === "text" && event.part?.text) {
            issueText += event.part.text;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;
    const stderrContent = await stderrPromise;
    jobLog(job.id, `opencode issue gen finished: exit ${exitCode}, ${eventCount} events, output ${issueText.length} chars (${(performance.now() - runStart).toFixed(0)}ms)`);

    if (exitCode !== 0) {
      jobLog(job.id, `Issue generation stderr: ${stderrContent.slice(0, 300)}`);
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Issue generation failed (exit ${exitCode}): ${stderrContent.slice(0, 300)}`,
        level: "error",
      });
      return { issueNumber: null, issueTitle: "" };
    }

    const issueMatch = issueText.match(/<issue>([\s\S]*?)<\/issue>/i);
    let title: string;
    let body: string;
    if (issueMatch?.[1]) {
      const inner = issueMatch[1];
      const titleMatch = inner.match(/<title>([\s\S]*?)<\/title>/i);
      const bodyMatch = inner.match(/<description>([\s\S]*?)<\/description>/i);
      title = titleMatch?.[1]?.trim() || `[${job.repoSlug}] ${job.kind} report`;
      body = bodyMatch?.[1]?.trim() || `Automated ${job.kind} report for ${job.repoSlug}`;
    } else {
      const lines = issueText.trim().split("\n");
      title = lines[0]?.trim().replace(/^#+\s*/, "").trim() || `[${job.repoSlug}] ${job.kind} report`;
      body = lines.slice(1).join("\n").trim() || `Automated ${job.kind} report for ${job.repoSlug}`;
    }

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
        return { issueNumber: num, issueTitle: title };
      }
    }

    jobLog(job.id, `gh issue create returned non-zero exit ${ghExit}`);
    return { issueNumber: null, issueTitle: title };
  } catch (err) {
    jobLog(job.id, `Issue generation error:`, err);
    return { issueNumber: null, issueTitle: "" };
  }
}

// ── Plan agent ───────────────────────────────────────────────────────────────

async function runPlanAgent(
  job: Job,
  worktreePath: string,
  issueNumber: number | null,
  helperPath: string,
): Promise<{ planMd: string; sessionId: string }> {
  const issueRef = issueNumber ? ` The related GitHub issue is #${issueNumber}.` : "";
  const contextBlock = job.context
    ? `\n\nThe following is the Discord report thread context with file attachments:\n${job.context}`
    : "";
  const helperBlock = `\n\nYou can post messages to the Discord thread and interact with users by running \`${helperPath} info "your message"\`. You can also rename the thread with \`${helperPath} --rename "new name"\`. Use this to ask questions, confirm decisions, or get clarifications from the user.`;
  const prompt = [
    `You are a planning agent for a ${job.kind} task on repository ${job.repoSlug}.${issueRef}`,
    `Review the codebase and write a detailed implementation plan.`,
    `The plan will be displayed in a full-featured Markdown viewer that supports Mermaid diagrams, mathematical equations (LaTeX), code blocks with syntax highlighting, tables, task lists, and all other GitHub-flavored Markdown features. Use these liberally to make the plan clear and well-structured.`,
    `The plan should cover: files to change, approach, and any risk areas.`,
    `After saving the plan file, report the exact path where it was saved by writing a single line at the end of your response in this exact format: PLAN_PATH:/path/to/your/plan.md`,
    contextBlock,
    helperBlock,
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

// ── opencode JSON event handlers ──────────────────────────────────────────────

function shortPath(filePath: string, cwd?: string): string {
  if (cwd && filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length).replace(/^\//, "");
    const parts = rel.split("/");
    if (parts.length <= 3) return rel;
    return "…/" + parts.slice(-2).join("/");
  }
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return "…/" + parts.slice(-2).join("/");
}

type EventResult = { level: "info" | "debug" | "success"; message: string; append: boolean } | null;

function formatToolUse(part: any, cwd?: string): EventResult {
  const tool = part.tool as string;
  const state = part.state || {};
  const input = state.input || {};

  switch (tool) {
    case "read": {
      const path = input.filePath || "";
      if (!path) return null;
      const display = state.metadata?.display;
      if (display?.type === "directory") {
        return { message: `📂 \`${shortPath(path, cwd)}\``, level: "debug", append: true };
      }
      return { message: `📖 \`${shortPath(path, cwd)}\``, level: "debug", append: true };
    }

    case "write":
    case "create": {
      const path = input.filePath || input.path || "";
      return { message: `✏️ Writing \`${shortPath(path, cwd)}\``, level: "info", append: true };
    }

    case "edit": {
      const path = input.filePath || "";
      const oldStr = (input.oldString || "").split("\n")[0]?.trim().slice(0, 60) || "";
      const desc = oldStr ? ` — \`${oldStr}…\`` : "";
      return { message: `✏️ Editing \`${shortPath(path, cwd)}\`${desc}`, level: "info", append: true };
    }

    case "delete": {
      const path = input.filePath || "";
      return { message: `🗑️ Deleting \`${shortPath(path, cwd)}\``, level: "info", append: true };
    }

    case "bash": {
      const cmd = (input.command || "").trim();
      if (!cmd) return null;
      const display = cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
      return { message: `💻 \`${display}\``, level: "info", append: true };
    }

    case "grep":
    case "search": {
      const pattern = input.pattern || input.query || "";
      return { message: `🔍 \`${pattern}\``, level: "debug", append: true };
    }

    case "glob": {
      const pattern = input.pattern || "";
      return { message: `🔍 \`${pattern}\``, level: "debug", append: true };
    }

    case "todowrite": {
      const todos = input.todos || [];
      if (!todos.length) return null;
      const statusIcons: Record<string, string> = {
        pending: "🔲",
        in_progress: "🔄",
        completed: "✅",
        cancelled: "❌",
      };
      const lines = todos.map((t: any) => {
        const icon = statusIcons[t.status] || "🔲";
        return `${icon} ${t.content}`;
      });
      return { message: `📋 **Tasks:**\n${lines.join("\n")}`, level: "info", append: true };
    }

    default:
      return null;
  }
}

function handleJsonEvent(event: any, jobId: number, cwd: string): EventResult {
  const type = event.type as string;
  const part = event.part || {};

  switch (type) {
    case "step_start": {
      return { message: "🤔 Analyzing codebase...", level: "info", append: false };
    }

    case "reasoning": {
      const text = (part.text || "").trim();
      if (!text) return null;
      const truncated = text.length > 300 ? text.slice(0, 300) + "…" : text;
      return { message: `💭 ${truncated}`, level: "debug", append: true };
    }

    case "tool_use": {
      if (part.type === "tool") return formatToolUse(part, cwd);
      return null;
    }

    case "text": {
      if (part.type !== "text") return null;
      const text = (part.text || "").trim();
      if (!text) return null;
      const truncated = text.length > 500 ? text.slice(0, 500) + "…" : text;
      return { message: truncated, level: "info", append: true };
    }

    case "step_finish": {
      if (part.reason === "stop") {
        return { message: "✅ Task complete", level: "success", append: false };
      }
      return null;
    }

    default:
      return null;
  }
}

function extractPlanPath(text: string): string | null {
  const match = text.match(/PLAN_PATH:(.+)/);
  if (match?.[1]) return match[1].trim();
  const altMatch = text.match(/The plan has been written to (.+)/);
  if (altMatch?.[1]) return altMatch[1].trim();
  return null;
}

async function runOpencodeStreaming(
  jobId: number,
  cwd: string,
  argv: string[],
  extraArgs: string[] = [],
): Promise<{ planMd: string; sessionId: string }> {
  const fullArgs = [...argv, "--format", "json", ...skipPermissionsArg, ...extraArgs];
  jobLog(jobId, `Spawning: ${fullArgs.join(" ")}`);

  const proc = Bun.spawn(fullArgs, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let sessionId = "";
  let planPath: string | null = null;
  const textParts: string[] = [];
  let lineCount = 0;
  let buffer = "";

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const streamStart = performance.now();

  // Read stderr concurrently to prevent pipe buffer deadlock
  const stderrPromise = new Response(proc.stderr).text();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lineCount++;

        let event: any;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

        // Extract session ID from first event
        if (!sessionId && event.sessionID) {
          sessionId = event.sessionID;
          jobLog(jobId, `Session: ${sessionId}`);
        }

        const result = handleJsonEvent(event, jobId, cwd);
        if (result) {
          await client.postStatus
            .mutate({ jobId, message: result.message, level: result.level, append: result.append })
            .catch(() => {});
        }

        // Accumulate text for plan fallback
        if (event.type === "text" && event.part?.text?.trim()) {
          const text = event.part.text.trim();
          textParts.push(text);
          // Look for plan path marker in planning agent output
          if (!planPath) {
            const extracted = extractPlanPath(text);
            if (extracted) planPath = extracted;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Process any remaining buffered data
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim());
      if (!sessionId && event.sessionID) {
        sessionId = event.sessionID;
        jobLog(jobId, `Session: ${sessionId}`);
      }
      const result = handleJsonEvent(event, jobId, cwd);
      if (result) {
        await client.postStatus
          .mutate({ jobId, message: result.message, level: result.level, append: result.append })
          .catch(() => {});
      }
    } catch {
      // ignore partial/invalid JSON in tail buffer
    }
  }

  const elapsed = (performance.now() - streamStart).toFixed(0);
  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
  jobLog(jobId, `opencode finished: exit ${exitCode}, ${lineCount} events in ${elapsed}ms`);

  if (exitCode !== 0) {
    jobLog(jobId, `opencode stderr: ${stderr.slice(0, 500)}`);
    throw new Error(`opencode failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  let planMd: string;
  if (planPath) {
    jobLog(jobId, `Reading plan from reported path: ${planPath}`);
    planMd = await Bun.file(planPath).text().catch(() => {
      jobLog(jobId, `Failed to read plan from ${planPath}, falling back to text`);
      return textParts.join("\n\n");
    });
  } else if (textParts.length > 0) {
    jobLog(jobId, `No plan path reported, using ${textParts.length} text parts`);
    planMd = textParts.join("\n\n");
  } else {
    jobLog(jobId, `No plan path or text content available`);
    planMd = "";
  }

  if (!sessionId) {
    jobLog(jobId, `No session ID detected`);
  }

  return { planMd: planMd || "", sessionId: sessionId || `fallback-${jobId}` };
}

// ── Approval loop ────────────────────────────────────────────────────────────

async function waitForApproval(
  jobId: number,
  sessionId: string,
  worktreePath: string,
  job: Job,
  helperPath: string,
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

      const reviseStart = performance.now();
      let newPlan: string;
      let newSession: string;

      if (currentSession) {
        // Resume existing opencode session with suggestion
        jobLog(jobId, `Resuming opencode session ${currentSession} with suggestion`);
        const result = await runOpencodeStreaming(
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
        newPlan = result.planMd;
        newSession = result.sessionId;
      } else {
        // No session — start a fresh plan agent with the suggestion as prompt
        jobLog(jobId, `No session to resume, starting fresh plan agent`);
        const issueRef = current.issueNumber
          ? ` The related GitHub issue is #${current.issueNumber}.`
          : "";
        const prompt = [
          `You are a planning agent for a ${current.kind} task on repository ${current.repoSlug}.${issueRef}`,
          `Review the codebase and write a detailed implementation plan based on this suggestion: "${suggestion}".`,
          `The plan will be displayed in a full-featured Markdown viewer that supports Mermaid diagrams, mathematical equations (LaTeX), code blocks with syntax highlighting, tables, task lists, and all other GitHub-flavored Markdown features. Use these liberally to make the plan clear and well-structured.`,
          `The plan should cover: files to change, approach, and any risk areas.`,
    `Write the plan to \`$HOME/.local/share/opencode/plans/\` (create the directory if it doesn't exist). After saving, report the exact path by writing a single line at the end of your response in this exact format: PLAN_PATH:/path/to/your/plan.md`,
          current.context ? `\n\nDiscord report context:\n${current.context}` : "",
          `\n\nYou can post messages to the Discord thread by running \`${helperPath} info "your message"\`. You can also rename the thread with \`${helperPath} --rename "new name"\`.`,
        ].filter(Boolean).join(" ");
        const result = await runOpencodeStreaming(
          jobId,
          worktreePath,
          ["opencode", "run", "--agent", "plan", "--dir", worktreePath, prompt],
        );
        newPlan = result.planMd;
        newSession = result.sessionId;
      }

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
  helperPath: string,
): Promise<string | null> {
  const issueRef = issueNumber
    ? `The related GitHub issue is #${issueNumber} — make sure the PR body contains "Closes #${issueNumber}".`
    : "";

  const prompt = [
    `Follow the plan in PLAN.md exactly to implement the required changes.`,
    issueRef,
    `When done, commit all changes with a clear message, push the branch, then create a pull request.`,
    `\n\nYou can post messages to the Discord thread by running \`${helperPath} info "your message"\`. You can also rename the thread with \`${helperPath} --rename "new name"\`.`,
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

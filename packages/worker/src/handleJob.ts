import { BOT_URL, SHARED_SECRET, dryRun } from "./env";
import { client, postInfo, postDebug } from "./trpc";
import type { Job } from "./trpc";
import { setActiveJobId, startTyping, stopTyping } from "./state";
import { jobLog } from "./logging";
import { createWorktree, cleanupWorktree, getRepoNameWithOwner } from "./worktree";
import { generateIssue } from "./issue";
import { runPlanAgent } from "./plan";
import { waitForApproval } from "./approval";
import { runBuildAgent } from "./build";

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
    setActiveJobId(null);
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
    setActiveJobId(null);
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
    helperPath = `/tmp/opencode-discord-${job.id}.ts`;
    const helperScript = `#!/usr/bin/env bun

const BOT_URL = "${BOT_URL}";
const TOKEN = "${SHARED_SECRET}";
const JOB_ID = ${job.id};

async function trpc(path: string, input: unknown) {
  const res = await fetch(BOT_URL + "/trpc/" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return res.json();
}

const cmd = process.argv[2];

if (cmd === "ask") {
  const questions = JSON.parse(process.argv.slice(3).join(" "));
  await trpc("askQuestion", { jobId: JOB_ID, questions });
  console.error("[ Waiting for answers in Discord thread... ]");
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await trpc("pollAnswer", { jobId: JOB_ID });
    const d = res?.result?.data;
    if (d?.answered && d?.formatted) {
      console.log(d.formatted);
      break;
    }
  }
} else if (cmd === "--rename") {
  await trpc("renameJobThread", { jobId: JOB_ID, name: process.argv[3] });
} else {
  await trpc("postStatus", { jobId: JOB_ID, message: cmd ?? "", level: process.argv[3] ?? "info" });
}
`;
    await Bun.write(helperPath, helperScript);
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

    // ── Step 3: Plan agent + Step 4: Approval (skip in quick mode) ─────────
    let finalSessionId: string | null | undefined;

    if (!job.quickMode) {
      jobLog(job.id, "Step 3/5: Running plan agent...");
      await postInfo(job.id, "Planning started — running opencode plan agent...");

      const planStart = performance.now();
      const { planMd, sessionId } = await runPlanAgent(job, worktreePath, issueNumber, helperPath);
      jobLog(job.id, `Plan agent completed in ${(performance.now() - planStart).toFixed(0)}ms, session: ${sessionId}, plan length: ${planMd.length} chars`);

      await postInfo(job.id, "Planning complete, posting plan for review...");

      jobLog(job.id, `Posting plan to Discord thread via planReady...`);
      await client.planReady.mutate({ jobId: job.id, planMd, sessionId });
      jobLog(job.id, `Plan posted to Discord`);

      // ── Step 4: Approval loop ────────────────────────────────────────────
      jobLog(job.id, "Step 4/5: Waiting for approval...");
      finalSessionId = await waitForApproval(job.id, sessionId, worktreePath, job, helperPath);
      if (finalSessionId === null) {
        jobLog(job.id, "Job was cancelled by user");
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
        setActiveJobId(null);
        return;
      }
      jobLog(job.id, `Approval received, session: ${finalSessionId}`);
    } else {
      await postInfo(job.id, "Quick mode — skipping planning phase");
    }

    // ── Final Step: Build agent ────────────────────────────────────────────
    jobLog(job.id, job.quickMode ? "Final step: Starting build agent..." : "Step 5/5: Starting build agent...");
    await postInfo(job.id, "Starting build agent...");

    const buildStart = performance.now();
    const prUrl = await runBuildAgent(job, worktreePath, issueNumber, branch, helperPath, job.autoMode, job.quickMode);
    jobLog(job.id, `Build agent completed in ${(performance.now() - buildStart).toFixed(0)}ms`);

    if (prUrl) {
      jobLog(job.id, `PR created: ${prUrl}`);
      await client.markComplete.mutate({ jobId: job.id, prUrl }).catch((err) => {
        jobLog(job.id, `Failed to mark job complete: ${err}`);
      });
    } else {
      jobLog(job.id, `Build completed but no PR URL found`);
      await client.postStatus.mutate({
        jobId: job.id,
        message: "Build completed but PR URL could not be determined",
        level: "error",
      });
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
  setActiveJobId(null);
}

export { handleJob };

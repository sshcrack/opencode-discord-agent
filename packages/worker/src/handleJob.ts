import { BOT_URL, SHARED_SECRET, WORKER_ID, dryRun, isENOENT, formatENOENT, AUGMENTED_PATH } from "./env";
import { client, postInfo, postDebug } from "./trpc";
import type { Job } from "./trpc";
import path from "node:path";

import { jobLog } from "./logging";
import { execCommand } from "./exec";
import { trackProcess } from "./processes";
import { ensureWorktree, ensureFollowupWorktree, ensureReviewWorktree, cleanupWorktree, getRepoNameWithOwner, setupGitAuthor, getPRBaseBranch } from "./worktree";
import { generateIssue } from "./issue";
import { runPlanAgent } from "./plan";
import { waitForApproval } from "./approval";
import { runBuildAgent } from "./build";
import { runReviewAgent } from "./review";
import { mergePR } from "./merge";
import { runOpencodeStreaming } from "./opencode";

/** Remove temp file, swallowing errors */
function cleanupHelper(helperPath: string) {
  if (helperPath) Bun.spawnSync(["rm", "-f", helperPath]);
}

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
    return;
  }

  jobLog(job.id, `Starting job for ${job.repoSlug} at ${repoPath} (kind: ${job.kind}, auto: ${job.autoMode}, dryRun: ${dryRun})`);
  if (job.issueNumber) jobLog(job.id, `Pre-existing issue #${job.issueNumber}`);
  if (job.context) jobLog(job.id, `Context length: ${job.context.length} chars`);

  const jobStart = performance.now();
  let helperPath = "";
  let isFollowUp = false;
  let isReviewMerge = false;
  let followUpSession: string | null = null;
  let followUpIssueNumber: number | null = null;
  let followUpBranch: string | null = null;

  // ── Detect standalone review job (no parent, direct prUrl) ──
  const isDirectReview = job.context === "review-merge"
    && !!job.prUrl
    && !job.parentJobId;

  if (isDirectReview) {
    isReviewMerge = true;
    jobLog(job.id, `Standalone review job — PR: ${job.prUrl}`);
  }

  // ── Check if this is a follow-up job ─────────────────────────────────
  if (job.parentJobId) {
    isFollowUp = true;
    jobLog(job.id, `This is a follow-up to job #${job.parentJobId}`);
    let parent: Awaited<ReturnType<typeof client.getJobStatus.query>> | null = null;
    try {
      parent = await client.getJobStatus.query({ jobId: job.parentJobId, workerId: WORKER_ID });
      if (parent) {
        followUpSession = parent.buildSessionId;
        followUpIssueNumber = parent.issueNumber;
        followUpBranch = parent.branch;
        jobLog(job.id, `Parent build session: ${followUpSession ?? "none"}, issue: ${followUpIssueNumber}, branch: ${followUpBranch ?? "none"}`);
      } else {
        jobLog(job.id, `Parent job #${job.parentJobId} not found — treating as fresh job`);
        isFollowUp = false;
      }
    } catch (err: unknown) {
      jobLog(job.id, `Failed to fetch parent job #${job.parentJobId}: ${err instanceof Error ? err.message : String(err)}`);
      isFollowUp = false;
    }

    if (parent?.prUrl && job.context === "review-merge") {
      isReviewMerge = true;
      jobLog(job.id, `Review-merge job detected — parent job has PR: ${parent.prUrl}`);
    }
  }

  try {
    // ── Step 1: Create worktree ────────────────────────────────────────────
    let branch: string;
    let worktreePath: string;

    if (isDirectReview) {
      await postInfo(job.id, "Fetching PR branch and creating worktree...");
      const prMatch = job.prUrl!.match(/\/pull\/(\d+)$/);
      if (!prMatch) {
        jobLog(job.id, `Could not extract PR number from URL: ${job.prUrl}`);
        await client.postStatus.mutate({ jobId: job.id, message: "Invalid PR URL", level: "error" });
        await client.cancelJob.mutate({ jobId: job.id });
        return;
      }
      const prNum = parseInt(prMatch[1]!, 10);
      const result = await ensureReviewWorktree(repoPath, prNum, job.id);
      branch = result.branch;
      worktreePath = result.worktreePath;
    } else if (isFollowUp && followUpBranch) {
      jobLog(job.id, "Step 1/5: Creating follow-up worktree from parent branch...");
      await postInfo(job.id, "Creating worktree from parent branch...");
      branch = `followup-${job.id}`;
      worktreePath = await ensureFollowupWorktree(repoPath, followUpBranch, branch, job.id);
      jobLog(job.id, `Follow-up worktree created at ${worktreePath} on branch ${branch}`);
    } else {
      jobLog(job.id, "Step 1/5: Creating worktree...");
      await postInfo(job.id, "Creating worktree...");
      branch = `report-${job.id}`;
      const stepStart = performance.now();
      worktreePath = await ensureWorktree(repoPath, branch, job.id);
      jobLog(job.id, `Worktree created at ${worktreePath} (${(performance.now() - stepStart).toFixed(0)}ms)`);
    }

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
  console.log(JSON.stringify({ type: "questions_posted", count: questions.length }));
} else if (cmd === "--rename") {
  await trpc("renameJobThread", { jobId: JOB_ID, name: process.argv[3] });
} else {
  await trpc("postStatus", { jobId: JOB_ID, message: cmd ?? "", level: process.argv[3] ?? "info" });
}
`;
    await Bun.write(helperPath, helperScript);
    Bun.spawnSync(["chmod", "700", helperPath]);
    jobLog(job.id, `Discord helper created at ${helperPath}`);

    // ── Review-Merge Workflow ─────────────────────────────────────────────
    if (isReviewMerge) {
      let prUrl: string | null | undefined = job.prUrl;
      if (!prUrl && job.parentJobId) {
        const parent = await client.getJobStatus.query({ jobId: job.parentJobId, workerId: WORKER_ID });
        prUrl = parent?.prUrl;
      }
      if (!prUrl) {
        await client.postStatus.mutate({ jobId: job.id, message: "No PR URL available for review", level: "error" });
        await client.cancelJob.mutate({ jobId: job.id });
        cleanupWorktree(repoPath, branch).catch(() => {});
        cleanupHelper(helperPath);
        return;
      }

      // Fetch PR base branch to ensure merge diff is computed correctly
      const baseBranch = await getPRBaseBranch(repoPath, prUrl, job.id);
      if (baseBranch !== followUpBranch) {
        jobLog(job.id, `Resetting worktree to PR base branch: ${baseBranch}`);
        await execCommand("git", ["fetch", "origin", baseBranch], worktreePath, job.id);
        await execCommand("git", ["reset", "--hard", `origin/${baseBranch}`], worktreePath, job.id);
      }

      await setupGitAuthor(worktreePath, job.id);
      await postInfo(job.id, "Git author configured for fix commits");

      const maxIterations = 3;
      let clean = false;

      for (let iteration = 0; iteration < maxIterations && !clean; iteration++) {
        await client.postStatus.mutate({
          jobId: job.id,
          message: `🔍 Review iteration ${iteration + 1}/${maxIterations}...`,
          level: "info",
        });

        const review = await runReviewAgent(job, worktreePath, prUrl, helperPath, iteration);

        if (review.clean) {
          clean = true;
          await client.postStatus.mutate({
            jobId: job.id,
            message: `✅ Review passed — no issues found`,
            level: "success",
          });
        } else {
          const issueCount = review.issues?.length ?? 0;
          const isLastIteration = iteration >= maxIterations - 1;

          if (isLastIteration) {
            await client.postStatus.mutate({
              jobId: job.id,
              message: `❌ Review failed — max iterations reached with ${issueCount} unresolved issue(s). PR requires manual attention.`,
              level: "error",
            });
            await client.cancelJob.mutate({ jobId: job.id });
            cleanupWorktree(repoPath, branch).catch(() => {});
            cleanupHelper(helperPath);
            return;
          }

          await client.postStatus.mutate({
            jobId: job.id,
            message: `🔧 Found ${issueCount} issue(s) — running fix agent...`,
            level: "info",
          });

          const fixPrompt = [
            `Fix the following issues found by the code review agent:`,
            review.issues?.map(i => `- **${i.file}**${i.line ? `:${i.line}` : ""}: ${i.description}`).join("\n") ?? "",
            `After fixing all issues, commit with a clear message and push to the existing branch.`,
            `Do NOT create a new PR — update the existing one.`,
            `Use ${helperPath} for Discord messages.`,
          ].join("\n\n");

          const fixArgs = [
            "opencode", "run",
            "--agent", "build",
            "--dir", worktreePath,
            fixPrompt,
          ];

          await runOpencodeStreaming(job.id, worktreePath, undefined, fixArgs);
          jobLog(job.id, `Fix iteration ${iteration + 1} completed`);
        }
      }

      const mergeResult = await mergePR(job.id, worktreePath, prUrl);

      if (mergeResult.success) {
        await client.postStatus.mutate({
          jobId: job.id,
          message: mergeResult.method === "auto-merge"
            ? `✅ Auto-merge enabled — PR will merge when CI passes`
            : `✅ PR merged via squash merge`,
          level: "success",
        });

        await client.markComplete.mutate({
          jobId: job.id,
          prUrl,
          branch,
        }).catch((err) => {
          jobLog(job.id, `Failed to mark job complete: ${err}`);
        });

        // Close thread immediately for squash merges; auto-merge checked via polling
        if (mergeResult.method === "squash") {
          await client.closeJobThread.mutate({ jobId: job.id }).catch((err) => {
            jobLog(job.id, `Failed to close thread after merge: ${err}`);
          });
        }
      } else {
        await client.postStatus.mutate({
          jobId: job.id,
          message: `❌ Merge failed: ${mergeResult.error ?? "Unknown error"}`,
          level: "error",
        });
        await client.postStatus.mutate({
          jobId: job.id,
          message: `💡 You may need to resolve conflicts or merge manually: ${prUrl}`,
          level: "info",
        });
      }

      cleanupWorktree(repoPath, branch).catch(() => {});
      cleanupHelper(helperPath);
      return;
    }

    // ── Step 2: Issue generation (skip for follow-ups) ────────────────────
    let issueNumber = job.issueNumber ?? followUpIssueNumber;

    if (!issueNumber && !isFollowUp) {
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
    } else if (issueNumber) {
      jobLog(job.id, `Using existing issue #${issueNumber}${isFollowUp ? " (from parent job)" : ""}`);
    }

    // Rename thread for pre-existing issues (was never renamed at creation)
    if (issueNumber && job.issueNumber && !isFollowUp) {
      jobLog(job.id, `Renaming thread for pre-existing issue #${issueNumber}...`);
      if (dryRun) {
        jobLog(job.id, `[DRY RUN] Would rename thread to #${issueNumber} {title}`);
      } else {
        const repoName = await getRepoNameWithOwner(repoPath);
        if (repoName) {
          const ghProc = (() => {
            try {
              return trackProcess(Bun.spawn(["gh", "issue", "view", String(issueNumber), "--repo", repoName, "--json", "title", "--jq", ".title"], {
                cwd: repoPath,
                stdout: "pipe",
                stderr: "pipe",
              }));
            } catch (err: unknown) {
              if (isENOENT(err)) throw new Error(formatENOENT("gh"), { cause: err });
              throw err;
            }
          })();
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

    // ── Step 3: Plan agent + Step 4: Approval (skip in quick mode and follow-up) ─
    let finalSessionId: string | null | undefined;

    if (isFollowUp) {
      jobLog(job.id, "Follow-up job — skipping planning phase, resuming build session");
      await postInfo(job.id, "Continuing previous session...");
    } else if (!job.quickMode) {
      jobLog(job.id, "Step 3/5: Running plan agent...");
      await postInfo(job.id, "Planning started — running opencode plan agent...");

      const planStart = performance.now();
      let { planMd, sessionId } = await runPlanAgent(job, worktreePath, issueNumber, helperPath);
      jobLog(job.id, `Plan agent completed in ${(performance.now() - planStart).toFixed(0)}ms, session: ${sessionId}, plan length: ${planMd.length} chars`);

      // Check if the agent asked questions — if so, wait for answers and inject them
      if (!job.autoMode && sessionId) {
        const planDir = path.join(worktreePath, ".opencode", "plans");
        const planFileName = `plan-${job.id}-${job.repoSlug.replace(/[^a-zA-Z0-9]/g, "-")}.md`;
        const planFilePath = path.join(planDir, planFileName);

        const injected = await pollAndInjectAnswers(job.id, sessionId, worktreePath, planFilePath);
        if (injected) {
          planMd = injected.planMd;
          sessionId = injected.sessionId;
          jobLog(job.id, `Answers injected, revised plan length: ${planMd.length} chars`);
        }
      }

      await postInfo(job.id, "Planning complete, posting plan for review...");

      jobLog(job.id, `Posting plan to Discord thread via planReady...`);
      const planResult = await client.planReady.mutate({ jobId: job.id, planMd, sessionId });
      if (!planResult.success) {
        jobLog(job.id, `Plan post failed — thread may have been deleted, aborting`);
        await client.postStatus.mutate({
          jobId: job.id,
          message: "Plan could not be posted — Discord thread may have been deleted",
          level: "error",
        });
        return;
      }
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
            const closeProc = (() => {
              try {
                return trackProcess(Bun.spawn(["gh", ...closeArgs], { cwd: repoPath, stdout: "pipe", stderr: "pipe" }));
              } catch (err: unknown) {
                if (isENOENT(err)) throw new Error(formatENOENT("gh"), { cause: err });
                throw err;
              }
            })();
            await closeProc.exited;
          }
        }
        await client.postStatus.mutate({
          jobId: job.id,
          message: "Job cancelled",
          level: "error",
        });
        cleanupWorktree(repoPath, branch).catch(() => {});
        cleanupHelper(helperPath);
        return;
      }
      jobLog(job.id, `Approval received, session: ${finalSessionId}`);
    } else {
      await postInfo(job.id, "Quick mode — skipping planning phase");
    }

    // ── Final Step: Build agent ────────────────────────────────────────────
    if (isFollowUp) {
      await postInfo(job.id, "Resuming build session with new context...");
    } else {
      jobLog(job.id, job.quickMode ? "Final step: Starting build agent..." : "Step 5/5: Starting build agent...");
      await postInfo(job.id, "Starting build agent...");
    }

    const buildStart = performance.now();
    const buildResult = await runBuildAgent(
      job, worktreePath, issueNumber, branch, helperPath,
      job.autoMode, job.quickMode,
      isFollowUp ? followUpSession : null,
    );
    jobLog(job.id, `Build agent completed in ${(performance.now() - buildStart).toFixed(0)}ms`);

    if (buildResult.prUrl) {
      jobLog(job.id, `PR created: ${buildResult.prUrl}`);
      await client.markComplete.mutate({
        jobId: job.id,
        prUrl: buildResult.prUrl,
        buildSessionId: buildResult.sessionId ?? undefined,
        branch,
      }).catch((err) => {
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

    cleanupWorktree(repoPath, branch).catch(() => {});
    cleanupHelper(helperPath);
  } catch (err: unknown) {
    const elapsed = ((performance.now() - jobStart) / 1000).toFixed(1);
    const message = err instanceof Error ? err.message : String(err);
    jobLog(job.id, `Job FAILED after ${elapsed}s: ${message}`);
    if (err instanceof Error && err.stack) jobLog(job.id, `Stack: ${err.stack}`);
    cleanupHelper(helperPath);

    const displayMessage = isENOENT(err)
      ? `Job failed: ${message}\n💡 This usually means a required tool is missing from PATH. Check that git, gh, gwq, opencode, and bun are installed and accessible. Current PATH: ${AUGMENTED_PATH}`
      : `Job failed: ${message}`;

    await client.postStatus.mutate({
      jobId: job.id,
      message: displayMessage,
      level: "error",
    });
  }

  const totalElapsed = ((performance.now() - jobStart) / 1000).toFixed(1);
  jobLog(job.id, `Job finished in ${totalElapsed}s`);
}

function formatQaBlock(
  questions: { q: string; options: string[]; recommended: number }[],
  answers: { q: string; a: string }[],
): string {
  return questions.map((q, i) => {
    const a = answers[i]?.a ?? "(unanswered)";
    return `Q: ${q.q}\nA: ${a}`;
  }).join("\n\n");
}

async function pollAndInjectAnswers(
  jobId: number,
  sessionId: string,
  worktreePath: string,
  planFilePath: string,
): Promise<{ planMd: string; sessionId: string } | null> {
  const initial = await client.getJobStatus.query({ jobId, workerId: WORKER_ID }).catch(() => null);
  if (!initial || !initial.pendingQuestions) return null;

  jobLog(jobId, `Agent asked questions, waiting for answers (no timeout)...`);
  await postInfo(jobId, "ℹ️ Agent has questions — please answer them in this thread");

  while (true) {
    await Bun.sleep(3000);
    const status = await client.getJobStatus.query({ jobId, workerId: WORKER_ID }).catch(() => null);
    if (!status) continue;

    if (status.status === "failed" || status.status === "cancelled" || status.status === "done") {
      jobLog(jobId, `Job ${status.status} while waiting for answers, aborting`);
      return null;
    }

    // Questions were cleared externally (e.g. cancelQuestions)
    if (!status.pendingQuestions) {
      jobLog(jobId, `Pending questions cleared — aborting answer wait`);
      return null;
    }

    if (status.pendingAnswers) {
      const questions = JSON.parse(status.pendingQuestions) as unknown[];
      const answers = JSON.parse(status.pendingAnswers) as unknown[];
      if (answers.length >= questions.length) {
        if (status.statusMessageId) {
          // Overview is still showing — waiting for user to Approve/Redo/Cancel
          continue;
        }
        const qaBlock = formatQaBlock(
          questions as { q: string; options: string[]; recommended: number }[],
          answers as { q: string; a: string }[],
        );
        jobLog(jobId, `Answers received, injecting into session ${sessionId}`);
        await postInfo(jobId, "✅ Answers received, revising plan...");

        const result = await runOpencodeStreaming(
          jobId,
          worktreePath,
          planFilePath,
          [
            "opencode", "run",
            "--agent", "plan",
            "--session", sessionId,
            "--continue",
            "--dir", worktreePath,
            `The user answered your questions:\n${qaBlock}\n\nConsider their input and finalize the plan accordingly.`,
          ],
        );
        return { planMd: result.planMd, sessionId: result.sessionId || sessionId };
      }
    }
  }
}

export { handleJob };

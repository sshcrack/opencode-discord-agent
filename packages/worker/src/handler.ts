import { execSync } from "node:child_process";
import { type JobPayload } from "@discord-agent/shared";
import { postStatus, planReady, trpc } from "./reporter";
import * as planner from "./planner";
import * as builder from "./builder";

const reposRoot = process.env.REPOS_ROOT || "/tmp/opencode-worktrees";

export async function handle(job: {
  id: string;
  payload: JobPayload;
  worktreeBranch: string | null;
  status: string;
}) {
  const branch = job.worktreeBranch || `fix/${job.payload.kind?.toLowerCase() ?? "task"}-${job.id.slice(0, 6)}`;

  await postStatus(job.id, "🔧 Worker picked up job — preparing worktree…");

  // Ensure repos root exists
  execSync(`mkdir -p ${reposRoot}`, { encoding: "utf-8" });

  // Create worktree via gwq
  const repo = job.payload.repo;
  const repoDir = `${reposRoot}/${repo.replace("/", "-")}`;

  try {
    execSync(`gwq add -b ${branch}`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 30_000,
    });
  } catch {
    execSync(`mkdir -p ${repoDir}`, { encoding: "utf-8" });
    execSync(`git clone git@github.com:${repo}.git ${repoDir}`, {
      encoding: "utf-8",
      timeout: 60_000,
    });
    execSync(`gwq add -b ${branch}`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 30_000,
    });
  }

  let worktreeDir: string;
  try {
    worktreeDir = execSync(`gwq get ${branch}`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch {
    worktreeDir = repoDir;
  }

  try {
    // Step 1: Plan
    await postStatus(job.id, "📋 Planning phase started…");
    const planResult = await planner.run(
      { id: job.id, payload: job.payload },
      worktreeDir,
    );

    // Step 2: Post plan for approval
    await planReady(job.id, planResult.planMarkdown, planResult.sessionId);

    // Step 3: Wait for approval (poll loop)
    let currentSessionId = planResult.sessionId;
    let approved = false;
    let cancelled = false;

    while (!approved && !cancelled) {
      await sleep(3000);

      // Poll job status from bot
      const response: any = await trpc.pollNextJob.query({
        workerId: process.env.WORKER_ID || "unknown",
      });

      if (!response.job) continue;

      if (response.job.status === "BUILDING") {
        approved = true;
      } else if (response.job.status === "CANCELLED") {
        cancelled = true;
      } else if (
        response.job.status === "AWAITING_APPROVAL" &&
        response.job.payload?.pendingSuggestion
      ) {
        const suggestion = response.job.payload.pendingSuggestion;
        await postStatus(job.id, "✏️ Revising plan based on suggestion…");

        const revised = await planner.revise(suggestion, currentSessionId, worktreeDir);
        currentSessionId = revised.sessionId;

        await planReady(job.id, revised.planMarkdown, currentSessionId);
      }
    }

    if (cancelled) {
      await postStatus(job.id, "❌ Job cancelled by user.", "error");
      cleanupWorktree(branch, repoDir);
      return;
    }

    // Step 4: Build
    await builder.run(job.id, worktreeDir);

    // Step 5: Create PR
    const title = `${job.payload.kind.toLowerCase()}: ${job.payload.context.split("\n")[0]?.slice(0, 60) || "automated fix"}`;
    const prUrl = execSync(
      `gh pr create --repo ${job.payload.repo} --head ${branch} --title ${JSON.stringify(title)} --fill`,
      {
        cwd: worktreeDir,
        encoding: "utf-8",
        timeout: 30_000,
      },
    ).trim();

    await postStatus(job.id, "PR opened", "success", { prUrl });

    // Cleanup
    cleanupWorktree(branch, repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await postStatus(job.id, `❌ Job failed: ${message}`, "error");
    cleanupWorktree(branch, repoDir);
  }
}

function cleanupWorktree(branch: string, repoDir: string) {
  try {
    execSync(`gwq remove ${branch} --force`, {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 15_000,
    });
  } catch {
    // best-effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { type JobPayload } from "@discord-agent/shared";
import { postStatus, planReady, trpc } from "./reporter";
import * as planner from "./planner";
import * as builder from "./builder";

export async function handle(job: {
  id: string;
  payload: JobPayload;
  worktreeBranch: string | null;
  status: string;
  repoPath: string;
}) {
  const workDir = job.repoPath;

  if (!existsSync(workDir)) {
    await postStatus(job.id, `❌ Repository path does not exist: \`${workDir}\``, "error");
    return;
  }

  await postStatus(job.id, `🔧 Worker picked up job — working in \`${workDir}\``);

  try {
    // Step 1: Plan
    await postStatus(job.id, "📋 Planning phase started…");
    const planResult = await planner.run(
      { id: job.id, payload: job.payload },
      workDir,
    );

    // Step 2: Post plan for approval
    await planReady(job.id, planResult.planMarkdown, planResult.sessionId);

    // Step 3: Wait for approval (poll loop via tRPC)
    let currentSessionId = planResult.sessionId;
    let approved = false;
    let cancelled = false;

    while (!approved && !cancelled) {
      await sleep(3000);

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

        const revised = await planner.revise(suggestion, currentSessionId, workDir);
        currentSessionId = revised.sessionId;

        await planReady(job.id, revised.planMarkdown, currentSessionId);
      }
    }

    if (cancelled) {
      await postStatus(job.id, "❌ Job cancelled by user.", "error");
      return;
    }

    // Step 4: Build
    await builder.run(job.id, workDir);

    // Step 5: Create PR if this is a git repo with a remote
    const isGitRepo = execSync("git rev-parse --is-inside-work-tree 2>/dev/null || echo false", {
      cwd: workDir,
      encoding: "utf-8",
    }).trim() === "true";

    if (isGitRepo) {
      try {
        const branch = job.worktreeBranch || `fix/${job.payload.kind?.toLowerCase() ?? "task"}-${job.id.slice(0, 6)}`;
        execSync(`git checkout -b ${branch}`, { cwd: workDir, encoding: "utf-8" });

        const remote = execSync("git remote get-url origin 2>/dev/null || echo none", {
          cwd: workDir,
          encoding: "utf-8",
        }).trim();

        if (remote !== "none") {
          execSync(`git push origin ${branch}`, { cwd: workDir, encoding: "utf-8", timeout: 60_000 });

          const title = `${job.payload.kind.toLowerCase()}: ${job.payload.context.split("\n")[0]?.slice(0, 60) || "automated fix"}`;
          const prUrl = execSync(
            `gh pr create --head ${branch} --title ${JSON.stringify(title)} --fill`,
            { cwd: workDir, encoding: "utf-8", timeout: 30_000 },
          ).trim();

          await postStatus(job.id, "PR opened", "success", { prUrl });
        }
      } catch {
        await postStatus(job.id, "⚠️ Git operations failed — changes are in the working directory.");
      }
    }

    await postStatus(job.id, "✅ Job complete", "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await postStatus(job.id, `❌ Job failed: ${message}`, "error");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

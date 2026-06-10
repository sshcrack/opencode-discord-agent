import { dryRun } from "./env";
import { jobLog } from "./logging";
import { execCommand } from "./exec";

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

export { createWorktree, cleanupWorktree, getRepoNameWithOwner };

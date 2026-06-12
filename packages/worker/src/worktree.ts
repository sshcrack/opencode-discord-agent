import { dryRun } from "./env";
import { jobLog } from "./logging";
import { execCommand } from "./exec";

async function ensureWorktree(repoPath: string, branch: string, jobId: number): Promise<string> {
  if (dryRun) {
    jobLog(jobId, `[DRY RUN] Checking existing worktrees for branch ${branch}`);
    jobLog(jobId, `[DRY RUN] gwq get ${branch} (in ${repoPath})`);
    jobLog(jobId, `[DRY RUN] Using repo path as worktree (no git worktree created)`);
    return repoPath;
  }

  try {
    const worktreePath = (await execCommand("gwq", ["get", branch], repoPath, jobId)).trim();
    jobLog(jobId, `Reusing existing worktree at ${worktreePath} for branch ${branch}`);
    return worktreePath;
  } catch {
    jobLog(jobId, `Branch ${branch} not found in gwq — creating new worktree`);
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
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

async function ensureFollowupWorktree(repoPath: string, parentBranch: string, newBranch: string, jobId: number): Promise<string> {
  if (dryRun) {
    jobLog(jobId, `[DRY RUN] Checking existing worktrees for branch ${newBranch}`);
    jobLog(jobId, `[DRY RUN] gwq get ${newBranch} (in ${repoPath})`);
    jobLog(jobId, `[DRY RUN] Using repo path as worktree (no git worktree created)`);
    return repoPath;
  }

  try {
    const worktreePath = (await execCommand("gwq", ["get", newBranch], repoPath, jobId)).trim();
    jobLog(jobId, `Reusing existing follow-up worktree at ${worktreePath} for branch ${newBranch}`);
    return worktreePath;
  } catch {
    jobLog(jobId, `Branch ${newBranch} not found in gwq — creating new follow-up worktree`);
  }

  jobLog(jobId, `Fetching parent branch: origin/${parentBranch}`);
  await execCommand("git", ["fetch", "origin", parentBranch], repoPath, jobId);

  const worktreePath = (await execCommand(
    "gwq", ["add", "-b", newBranch], repoPath, jobId,
  )).trim();

  await execCommand("git", ["reset", "--hard", `origin/${parentBranch}`], worktreePath, jobId);

  jobLog(jobId, `Follow-up worktree ready at ${worktreePath}, based on ${parentBranch}`);
  return worktreePath;
}

export { ensureWorktree, ensureFollowupWorktree, cleanupWorktree, getRepoNameWithOwner };

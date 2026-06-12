import { dryRun } from "./env";
import { jobLog } from "./logging";
import { execCommand } from "./exec";

async function setupGitAuthor(worktreePath: string, jobId: number): Promise<void> {
  jobLog(jobId, `Setting git author config in worktree at ${worktreePath}`);
  try {
    await execCommand("git", ["config", "user.name", "opencode-bot"], worktreePath, jobId);
    await execCommand("git", ["config", "user.email", "opencode-bot@users.noreply.github.com"], worktreePath, jobId);
    jobLog(jobId, "Git author configured as opencode-bot");
  } catch (err: unknown) {
    jobLog(jobId, `Failed to set git author config: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("Git author configuration failed — commits may fail without git config", { cause: err });
  }
}

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

async function getPRBaseBranch(repoPath: string, prUrl: string, jobId: number): Promise<string> {
  jobLog(jobId, `Fetching base branch for PR ${prUrl}`);
  try {
    const baseBranch = (await execCommand(
      "gh", ["pr", "view", prUrl, "--json", "baseRefName", "--jq", ".baseRefName"], repoPath, jobId,
    )).trim();
    jobLog(jobId, `PR base branch: ${baseBranch}`);
    return baseBranch;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    jobLog(jobId, `Failed to get PR base branch: ${message}, falling back to "main"`);
    return "main";
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

  jobLog(jobId, `Running: gwq add -b ${newBranch} (in ${repoPath})`);
  await execCommand("gwq", ["add", "-b", newBranch], repoPath, jobId);

  jobLog(jobId, `Running: gwq get ${newBranch}`);
  const worktreePath = (await execCommand("gwq", ["get", newBranch], repoPath, jobId)).trim();

  await execCommand("git", ["reset", "--hard", `origin/${parentBranch}`], worktreePath, jobId);

  jobLog(jobId, `Follow-up worktree ready at ${worktreePath}, based on ${parentBranch}`);
  return worktreePath;
}

async function ensureReviewWorktree(repoPath: string, prNumber: number, jobId: number): Promise<{ worktreePath: string; branch: string }> {
  const branch = `review-pr-${prNumber}-${jobId}`;

  if (dryRun) {
    jobLog(jobId, `[DRY RUN] Deleting stale local branch ${branch} (if exists)`);
    jobLog(jobId, `[DRY RUN] Fetching PR #${prNumber} head into refs/heads/${branch}`);
    jobLog(jobId, `[DRY RUN] gwq add ${branch} (in ${repoPath})`);
    return { worktreePath: repoPath, branch };
  }

  // Step 0: Delete stale local branch if it exists
  try {
    const existing = (await execCommand("git", ["branch", "--list", branch], repoPath, jobId)).trim();
    if (existing) {
      jobLog(jobId, `Deleting stale local branch ${branch} before PR fetch`);
      await execCommand("git", ["branch", "-D", branch], repoPath, jobId);
    }
  } catch { /* defensive — don't fail if branch --list errors */ }

  // Step 1: Fetch PR head as a local branch
  await execCommand("git", ["fetch", "origin", `pull/${prNumber}/head:refs/heads/${branch}`], repoPath, jobId);

  // Step 2: Reuse existing worktree if it exists
  try {
    const worktreePath = (await execCommand("gwq", ["get", branch], repoPath, jobId)).trim();
    jobLog(jobId, `Reusing existing worktree at ${worktreePath} for ${branch}`);
    return { worktreePath, branch };
  } catch {
    jobLog(jobId, `No existing worktree for ${branch} — creating new one`);
  }

  // Step 3: Create new worktree with gwq (no -b — branch already exists from Step 1)
  await execCommand("gwq", ["add", branch], repoPath, jobId);
  const worktreePath = (await execCommand("gwq", ["get", branch], repoPath, jobId)).trim();

  jobLog(jobId, `PR review worktree ready at ${worktreePath} for ${branch}`);
  return { worktreePath, branch };
}

export { setupGitAuthor, ensureWorktree, ensureFollowupWorktree, ensureReviewWorktree, cleanupWorktree, getRepoNameWithOwner, getPRBaseBranch };

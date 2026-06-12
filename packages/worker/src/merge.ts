import { postInfo } from "./trpc";
import { jobLog } from "./logging";
import { dryRun, isENOENT, formatENOENT } from "./env";
import { trackProcess } from "./processes";

interface MergeResult {
  method: "auto-merge" | "squash" | null;
  success: boolean;
  error?: string;
}

async function mergePR(jobId: number, worktreePath: string, prUrl: string): Promise<MergeResult> {
  jobLog(jobId, `Attempting to merge PR: ${prUrl}`);

  if (dryRun) {
    jobLog(jobId, `[DRY RUN] Would merge PR: ${prUrl}`);
    await postInfo(jobId, `[DRY RUN] PR merge skipped`);
    return { method: "squash", success: true };
  }

  jobLog(jobId, `Trying auto-merge: gh pr merge --auto --squash`);
  const autoProc = (() => {
    try {
      return trackProcess(Bun.spawn(
        ["gh", "pr", "merge", prUrl, "--auto", "--squash"],
        { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
      ));
    } catch (err: unknown) {
      if (isENOENT(err)) throw new Error(formatENOENT("gh"), { cause: err });
      throw err;
    }
  })();
  const autoExit = await autoProc.exited;
  const autoStderr = await new Response(autoProc.stderr).text();

  if (autoExit === 0) {
    jobLog(jobId, `Auto-merge enabled successfully`);
    await postInfo(jobId, `✅ Auto-merge enabled — PR will merge when CI passes`);
    return { method: "auto-merge", success: true };
  }

  jobLog(jobId, `Auto-merge failed (exit ${autoExit}): ${autoStderr.slice(0, 300)}, falling back to squash merge`);

  const squashProc = (() => {
    try {
      return trackProcess(Bun.spawn(
        ["gh", "pr", "merge", prUrl, "--squash"],
        { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
      ));
    } catch (err: unknown) {
      if (isENOENT(err)) throw new Error(formatENOENT("gh"), { cause: err });
      throw err;
    }
  })();
  const squashExit = await squashProc.exited;

  if (squashExit === 0) {
    jobLog(jobId, `PR merged via squash`);
    return { method: "squash", success: true };
  }

  const squashStderr = await new Response(squashProc.stderr).text();
  jobLog(jobId, `Squash merge also failed: ${squashStderr.slice(0, 300)}`);
  return { method: null, success: false, error: squashStderr.slice(0, 500) };
}

export { mergePR };
export type { MergeResult };

import { dryRun } from "./env";
import { client, postInfo } from "./trpc";
import { jobLog } from "./logging";
import { runOpencodeStreaming } from "./opencode";

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
    `When done, commit all changes with a clear message, push the branch, then create a pull request. After creating it, output the pull request URL.`,
    `\n\nYou can post messages to the Discord thread by running \`${helperPath} info "your message"\`. You can also rename the thread with \`${helperPath} --rename "new name"\`.`,
  ]
    .filter(Boolean)
    .join(" ");

  jobLog(jobId, `Build prompt: ${prompt.length} chars, issueRef: ${!!issueNumber}`);

  if (dryRun) {
    jobLog(jobId, `[DRY RUN] 🔧 Build agent`);
    jobLog(jobId, `[DRY RUN] Prompt: ${prompt}`);
    jobLog(jobId, `[DRY RUN] Would run: opencode run --agent build --print ...`);
    await postInfo(jobId, `[DRY RUN] Build agent skipped — prompt logged to worker console`);
    return null;
  }

  jobLog(jobId, `Starting opencode build agent in ${worktreePath}`);
  const buildStart = performance.now();
  await runOpencodeStreaming(jobId, worktreePath, [
    "opencode", "run", "--agent", "build", "--dir", worktreePath, prompt,
  ]);
  jobLog(jobId, `Build agent finished in ${(performance.now() - buildStart).toFixed(0)}ms`);

  const prView = Bun.spawnSync(["gh", "pr", "view", "--json", "url", "--jq", ".url"], {
    cwd: worktreePath,
  });

  if (prView.exitCode !== 0) {
    const stderr = prView.stderr.toString().trim().slice(0, 400);
    jobLog(jobId, `Failed to get PR URL: ${stderr}`);
    await client.postStatus.mutate({
      jobId,
      message: `Failed to find PR: ${stderr}`,
      level: "error",
    });
    return null;
  }

  const prUrl = prView.stdout.toString().trim();
  jobLog(jobId, `PR URL: ${prUrl}`);
  return prUrl || null;
}

export { runBuildAgent };

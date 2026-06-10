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

export { runBuildAgent };

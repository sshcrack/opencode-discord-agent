import { dryRun } from "./env";
import { client, postInfo } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { runOpencodeStreaming } from "./opencode";

async function runBuildAgent(
  job: Job,
  worktreePath: string,
  issueNumber: number | null,
  branch: string,
  helperPath: string,
  autoMode: boolean,
  quickMode: boolean,
): Promise<string | null> {
  const issueRef = issueNumber
    ? `The related GitHub issue is #${issueNumber} — make sure the PR body contains "Closes #${issueNumber}".`
    : "";

  const askBlock = autoMode ? "" : `\n\nYou can ask questions and wait for answers using:
\`${helperPath} ask '...json...'\`

The \`ask\` command takes a JSON array argument. Each object has:
  - "q" (required): the question text
  - "options" (required): proposed answers the user can pick from
  - "recommended" (required): index of the recommended option

Examples:
  # One question:
  ${helperPath} ask '[{"q":"What approach?","options":["Refactor","Rewrite"],"recommended":0}]'

  # Multiple questions (answered one at a time in Discord):
  ${helperPath} ask '[{"q":"Color?","options":["Red","Blue"],"recommended":0},{"q":"Size?","options":["S","M","L"],"recommended":1}]'

The script blocks until all questions are answered. The output is:
  Q: Color?
  A: Red

  Q: Size?
  A: Large

Always provide options + a recommended answer.`;

  const helperBlock = `\n\nYou can post messages to the Discord thread and rename it by running:
  \`${helperPath} info "message"\` — info level
  \`${helperPath} success "message"\` — success message
  \`${helperPath} error "message"\` — error message
  \`${helperPath} --rename "new name"\` — rename thread`;

  let prompt: string;

  if (quickMode) {
    const contextBlock = job.context
      ? `\n\nThe following is the Discord report thread context with file attachments:\n${job.context}`
      : "";
    prompt = [
      `You are building an implementation for repository ${job.repoSlug}.`,
      issueRef,
      contextBlock,
      `Review the context and issue above carefully, then implement the required changes.`,
      `When done, commit all changes with a clear message referencing the issue,`,
      `push the branch, then create a pull request. After creating it,`,
      `output the pull request URL.`,
      helperBlock,
      askBlock,
    ].filter(Boolean).join(" ");
  } else {
    prompt = [
      `Follow the plan in PLAN.md exactly to implement the required changes.`,
      issueRef,
      `When done, commit all changes with a clear message, push the branch, then create a pull request. After creating it, output the pull request URL.`,
      helperBlock,
      askBlock,
    ].filter(Boolean).join(" ");
  }

  jobLog(job.id, `Build prompt: ${prompt.length} chars, issueRef: ${!!issueNumber}, quickMode: ${quickMode}`);

  if (dryRun) {
    jobLog(job.id, `[DRY RUN] 🔧 Build agent`);
    jobLog(job.id, `[DRY RUN] Prompt: ${prompt}`);
    jobLog(job.id, `[DRY RUN] Would run: opencode run --agent build --print ...`);
    await postInfo(job.id, `[DRY RUN] Build agent skipped — prompt logged to worker console`);
    return null;
  }

  jobLog(job.id, `Starting opencode build agent in ${worktreePath}`);
  const buildStart = performance.now();
  await runOpencodeStreaming(job.id, worktreePath, [
    "opencode", "run", "--agent", "build", "--dir", worktreePath, prompt,
  ]);
  jobLog(job.id, `Build agent finished in ${(performance.now() - buildStart).toFixed(0)}ms`);

  const prView = Bun.spawnSync(["gh", "pr", "view", "--json", "url", "--jq", ".url"], {
    cwd: worktreePath,
  });

  if (prView.exitCode !== 0) {
    const stderr = prView.stderr.toString().trim().slice(0, 400);
    jobLog(job.id, `Failed to get PR URL: ${stderr}`);
    await client.postStatus.mutate({
      jobId: job.id,
      message: `Failed to find PR: ${stderr}`,
      level: "error",
    });
    return null;
  }

  const prUrl = prView.stdout.toString().trim();
  jobLog(job.id, `PR URL: ${prUrl}`);
  return prUrl || null;
}

export { runBuildAgent };

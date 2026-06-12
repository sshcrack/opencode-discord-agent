import path from "node:path";
import { dryRun, isENOENT, formatENOENT } from "./env";
import { postInfo } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { runOpencodeStreaming } from "./opencode";

interface ReviewResult {
  clean: boolean;
  issues?: { file: string; line?: number; description: string }[];
  summary: string;
}

async function runReviewAgent(
  job: Job,
  worktreePath: string,
  prUrl: string,
  helperPath: string,
  iteration: number,
): Promise<ReviewResult> {
  const reviewDir = path.join(worktreePath, ".opencode", "reviews");
  const reviewFilePath = path.join(reviewDir, `review-${job.id}.json`);

  try {
    Bun.spawnSync(["mkdir", "-p", reviewDir]);
  } catch (err: unknown) {
    if (isENOENT(err)) throw new Error(formatENOENT("mkdir"), { cause: err });
    throw err;
  }

  // Delete stale review file from previous iteration
  try {
    Bun.spawnSync(["rm", "-f", reviewFilePath]);
  } catch { /* not present — fine */ }

  const iterationNote = iteration > 0
    ? `\n\nThis is iteration ${iteration + 1} of the review loop. Previous issues were reported to be fixed — verify they are resolved.`
    : "";

  const prompt = [
    `Review the PR at ${prUrl} in the repository at ${worktreePath}.`,
    `Fetch the diff with \`gh pr diff "${prUrl}"\` and analyze the code.`,
    `Write your review results to \`${reviewFilePath}\` as JSON.`,
    `The JSON file must have this structure:`,
    `{ "clean": true/false, "issues": [{ "file": "...", "line": N, "description": "..." }], "summary": "..." }`,
    `"clean": true means no issues found. "clean": false means issues were found — list each issue.`,
    `\nReview for: bugs, logic errors, security problems, missing error handling, performance issues.`,
    `Skip: lockfile changes, generated files, vendored code, whitespace.`,
    iterationNote,
    `Use ${helperPath} for Discord messages.`,
  ].filter(Boolean).join("\n\n");

  jobLog(job.id, `Review iteration ${iteration + 1} — prompt: ${prompt.length} chars`);

  if (dryRun) {
    jobLog(job.id, `[DRY RUN] 🔍 Review agent (iteration ${iteration + 1})`);
    jobLog(job.id, `[DRY RUN] Would write to: ${reviewFilePath}`);
    await postInfo(job.id, `[DRY RUN] Review agent skipped — iteration ${iteration + 1}`);
    return { clean: true, summary: "[DRY RUN]" };
  }

  const reviewArgs = [
    "opencode", "run",
    "--agent", "PR review merge",
    "--dir", worktreePath,
    prompt,
  ];

  const { sessionId } = await runOpencodeStreaming(job.id, worktreePath, undefined, reviewArgs);
  jobLog(job.id, `Review agent done, session: ${sessionId}`);

  await Bun.sleep(500);
  const reviewFile = Bun.file(reviewFilePath);
  const exists = await reviewFile.exists();
  if (!exists) {
    throw new Error(
      `Review agent did not write output file at ${reviewFilePath}. ` +
      `The review agent may have crashed or timed out.`
    );
  }

  const content = await reviewFile.text();
  try {
    const result = JSON.parse(content) as ReviewResult;
    jobLog(job.id, `Review result: clean=${result.clean}, issues=${result.issues?.length ?? 0}`);
    return result;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(
        `Review agent wrote invalid JSON to ${reviewFilePath}: ${err.message}. ` +
        `Raw content (first 500 chars): ${content.slice(0, 500)}`,
        { cause: err },
      );
    }
    throw err;
  }
}

export { runReviewAgent };
export type { ReviewResult };

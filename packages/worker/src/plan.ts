import path from "node:path";
import { dryRun } from "./env";
import { postInfo } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { runOpencodeStreaming } from "./opencode";
import { getRepoNameWithOwner } from "./worktree";

async function runPlanAgent(
  job: Job,
  worktreePath: string,
  issueNumber: number | null,
  helperPath: string,
): Promise<{ planMd: string; sessionId: string; issueNumber: number | null }> {
  const repoName = await getRepoNameWithOwner(worktreePath).catch(() => "");

  const issueRef = issueNumber
    ? ` The related GitHub issue is #${issueNumber} — make sure the PR body contains "Closes #${issueNumber}".`
    : "";

  const createIssueBlock = issueNumber
    ? ""
    : `\n\nFirst, create a GitHub issue by running:
\`\`\`
gh issue create --title "Descriptive title summarizing the ${job.kind}" --body "Detailed issue body from the context below" ${repoName ? `--repo ${repoName}` : ""}
\`\`\`

The \`gh\` command will output the issue URL like \`https://github.com/owner/repo/issues/N\`. Note this issue number — it will be referenced in the next build step.
After creating the issue, write the plan below.`;

  const contextBlock = job.context
    ? `\n\nThe following is the Discord report thread context with file attachments:\n${job.context}`
    : "";

  const planDir = path.join(worktreePath, ".opencode", "plans");
  const planFileName = `plan-${job.id}-${job.repoSlug.replace(/[^a-zA-Z0-9]/g, "-")}.md`;
  const planFilePath = path.join(planDir, planFileName);

  const writeInstruction = `Write the plan to \`${planFilePath}\` (create the directory if it doesn't exist).`;

  const askBlock = job.autoMode ? "" : `\n\nIf you have questions, invoke the following script and then STOP — do NOT write the plan yet. Your questions and the answers will be provided in the next prompt, and you will continue from there:
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

If you do NOT have questions, ${writeInstruction.toLowerCase()} Always provide options + a recommended answer.`;

  const helperBlock = `\n\nYou can post messages to the Discord thread and rename it by running:
  \`${helperPath} info "message"\` — info level
  \`${helperPath} success "message"\` — success message
  \`${helperPath} error "message"\` — error message
  \`${helperPath} --rename "new name"\` — rename thread` + askBlock;
  const prompt = [
    `You are a planning agent for a ${job.kind} task on repository ${job.repoSlug}.${issueRef}`,
    `Review the codebase and write a detailed implementation plan.`,
    `The plan will be displayed in a full-featured Markdown viewer that supports Mermaid diagrams, mathematical equations (LaTeX), code blocks with syntax highlighting, tables, task lists, and all other GitHub-flavored Markdown features. Use these liberally to make the plan clear and well-structured.`,
    `The plan should cover: files to change, approach, and any risk areas.`,
    createIssueBlock,
    job.autoMode ? writeInstruction : "",
    contextBlock,
    helperBlock,
  ].filter(Boolean).join(" ");

  jobLog(job.id, `Plan agent prompt length: ${prompt.length} chars, issueRef: ${!!issueNumber}, contextBlock: ${!!job.context}`);

  if (dryRun) {
    jobLog(job.id, `[DRY RUN] 📋 Plan agent`);
    jobLog(job.id, `[DRY RUN] Prompt: ${prompt.slice(0, 200)}...`);
    jobLog(job.id, `[DRY RUN] Would run: opencode run --agent plan --print ...`);
    await postInfo(job.id, `[DRY RUN] Plan agent skipped — prompt logged to worker console`);
    return { planMd: "# DRY RUN — plan generation skipped", sessionId: `dry-run-${job.id}`, issueNumber: null };
  }

  jobLog(job.id, `Starting opencode plan agent in ${worktreePath}`);
  const result = await runOpencodeStreaming(job.id, worktreePath, planFilePath, ["opencode", "run", "--agent", "plan", "--dir", worktreePath, prompt]);
  return { planMd: result.planMd, sessionId: result.sessionId, issueNumber: result.issueNumber ?? issueNumber };
}

export { runPlanAgent };

import { dryRun } from "./env";
import { postInfo } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { runOpencodeStreaming } from "./opencode";

async function runPlanAgent(
  job: Job,
  worktreePath: string,
  issueNumber: number | null,
  helperPath: string,
): Promise<{ planMd: string; sessionId: string }> {
  const issueRef = issueNumber ? ` The related GitHub issue is #${issueNumber}.` : "";
  const contextBlock = job.context
    ? `\n\nThe following is the Discord report thread context with file attachments:\n${job.context}`
    : "";
  const helperBlock = `\n\nYou can post messages to the Discord thread and interact with users by running \`${helperPath} info "your message"\`. You can also rename the thread with \`${helperPath} --rename "new name"\`. Use this to ask questions, confirm decisions, or get clarifications from the user.`;
  const prompt = [
    `You are a planning agent for a ${job.kind} task on repository ${job.repoSlug}.${issueRef}`,
    `Review the codebase and write a detailed implementation plan.`,
    `The plan will be displayed in a full-featured Markdown viewer that supports Mermaid diagrams, mathematical equations (LaTeX), code blocks with syntax highlighting, tables, task lists, and all other GitHub-flavored Markdown features. Use these liberally to make the plan clear and well-structured.`,
    `The plan should cover: files to change, approach, and any risk areas.`,
    `After saving the plan file, report the exact path where it was saved by writing a single line at the end of your response in this exact format: PLAN_PATH:/path/to/your/plan.md`,
    contextBlock,
    helperBlock,
  ].filter(Boolean).join(" ");

  jobLog(job.id, `Plan agent prompt length: ${prompt.length} chars, issueRef: ${!!issueNumber}, contextBlock: ${!!job.context}`);

  if (dryRun) {
    jobLog(job.id, `[DRY RUN] 📋 Plan agent`);
    jobLog(job.id, `[DRY RUN] Prompt: ${prompt.slice(0, 200)}...`);
    jobLog(job.id, `[DRY RUN] Would run: opencode run --agent plan --print ...`);
    await postInfo(job.id, `[DRY RUN] Plan agent skipped — prompt logged to worker console`);
    return { planMd: "# DRY RUN — plan generation skipped", sessionId: `dry-run-${job.id}` };
  }

  jobLog(job.id, `Starting opencode plan agent in ${worktreePath}`);
  return runOpencodeStreaming(job.id, worktreePath, ["opencode", "run", "--agent", "plan", "--dir", worktreePath, prompt]);
}

export { runPlanAgent };

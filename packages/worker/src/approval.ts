import path from "node:path";
import { WORKER_ID } from "./env";
import { client, postInfo, postDebug } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { runOpencodeStreaming } from "./opencode";

async function waitForApproval(
  jobId: number,
  sessionId: string,
  worktreePath: string,
  job: Job,
  helperPath: string,
): Promise<string | null> {
  let currentSession = sessionId;
  let pollCount = 0;

  jobLog(jobId, `Entering approval loop, polling every 2s`);
  await postDebug(jobId, `Waiting for plan approval...`);

  while (true) {
    await Bun.sleep(2000);
    pollCount++;

    let current: Awaited<ReturnType<typeof client.getJobStatus.query>>;
    try {
      current = await client.getJobStatus.query({ jobId, workerId: WORKER_ID });
    } catch {
      jobLog(jobId, `Approval poll #${pollCount} failed (network error), retrying`);
      continue;
    }

    if (!current) {
      jobLog(jobId, `Approval poll #${pollCount}: job not found, returning null`);
      return null;
    }

    jobLog(jobId, `Approval poll #${pollCount}: status=${current.status}${current.pendingSuggestion ? `, suggestion="${current.pendingSuggestion}"` : ""}`);

    if (current.status === "approved") {
      jobLog(jobId, `Approved after ${pollCount} polls`);
      await postDebug(jobId, `Plan approved after ${pollCount * 2}s`);
      return currentSession;
    }
    if (current.status === "cancelled") {
      jobLog(jobId, `Cancelled after ${pollCount} polls`);
      return null;
    }
    if (current.status === "failed") {
      jobLog(jobId, `Job marked as failed after ${pollCount} polls`);
      return null;
    }

    if (current.status === "planning" && current.pendingSuggestion) {
      const suggestion = current.pendingSuggestion;
      jobLog(jobId, `Revising plan with suggestion: "${suggestion}"`);

      await client.ackSuggestion.mutate({ jobId }).catch(() => {});

      await client.postStatus.mutate({
        jobId,
        message: `Revising plan: "${suggestion}"`,
        level: "info",
      });

      const reviseStart = performance.now();
      let newPlan: string;
      let newSession: string;

      const planDir = path.join(worktreePath, ".opencode", "plans");
      const planFileName = `plan-${jobId}-${job.repoSlug.replace(/[^a-zA-Z0-9]/g, "-")}.md`;
      const planFilePath = path.join(planDir, planFileName);

      if (currentSession) {
        jobLog(jobId, `Resuming opencode session ${currentSession} with suggestion`);
        const result = await runOpencodeStreaming(
          jobId,
          worktreePath,
          planFilePath,
          [
            "opencode", "run",
            "--agent", "plan",
            "--session", currentSession,
            "--continue",
            "--dir", worktreePath,
            suggestion,
          ],
        );
        newPlan = result.planMd;
        newSession = result.sessionId;
      } else {
        jobLog(jobId, `No session to resume, starting fresh plan agent`);
        const issueRef = current.issueNumber
          ? ` The related GitHub issue is #${current.issueNumber}.`
          : "";
        const writeInstruction = `Write the plan to \`${planFilePath}\` (create the directory if it doesn't exist).`;

        const askBlock = current.autoMode ? "" : `\n\nIf you have questions, invoke the following script and then STOP — do NOT write the plan yet. Your questions and the answers will be provided in the next prompt, and you will continue from there:
  \`${helperPath} ask '...json...'\`

  The \`ask\` command takes a JSON array argument. Each object has:
    - "q" (required): the question text
    - "options" (required): proposed answers the user can pick from
    - "recommended" (required): index of the recommended option

  Examples:
    # One question:
    ${helperPath} ask '[{"q":"What approach?","options":["Refactor","Rewrite"],"recommended":0}]'

  If you do NOT have questions, ${writeInstruction.toLowerCase().replace("write the plan", "write the revised plan")} Always provide options + a recommended answer.`;

        const prompt = [
          `You are a planning agent for a ${current.kind} task on repository ${current.repoSlug}.${issueRef}`,
          `Review the codebase and write a detailed implementation plan based on this suggestion: "${suggestion}".`,
          `The plan will be displayed in a full-featured Markdown viewer that supports Mermaid diagrams, mathematical equations (LaTeX), code blocks with syntax highlighting, tables, task lists, and all other GitHub-flavored Markdown features. Use these liberally to make the plan clear and well-structured. When using mermaid diagrams, make sure to use double quotes for labels like so: K --> L["event.setRawAudio(translated)"], otherwise the diagrams won't render correctly.`,
          `The plan should cover: files to change, approach, and any risk areas.`,
          current.autoMode ? writeInstruction : "",
          current.context ? `\n\nDiscord report context:\n${current.context}` : "",
          `\n\nYou can post messages to the Discord thread and rename it by running:
  \`${helperPath} info "message"\` — info
  \`${helperPath} success "message"\` — success
  \`${helperPath} error "message"\` — error
  \`${helperPath} --rename "new name"\` — rename thread`,
          askBlock,
        ].filter(Boolean).join(" ");
        const result = await runOpencodeStreaming(
          jobId,
          worktreePath,
          planFilePath,
          ["opencode", "run", "--agent", "plan", "--dir", worktreePath, prompt],
        );
        newPlan = result.planMd;
        newSession = result.sessionId;
      }

      jobLog(jobId, `Plan revision completed in ${(performance.now() - reviseStart).toFixed(0)}ms, new session: ${newSession}`);

      currentSession = newSession || currentSession;

      await postInfo(jobId, "Plan revised, posting updated plan for review...");

      jobLog(jobId, `Posting revised plan via planReady`);
      await client.planReady.mutate({
        jobId,
        planMd: newPlan,
        sessionId: currentSession,
      });
    }
  }
}

export { waitForApproval };

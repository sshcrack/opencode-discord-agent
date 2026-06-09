import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type JobPayload } from "@discord-agent/shared";

export async function run(
  job: { id: string; payload: JobPayload },
  worktreeDir: string,
): Promise<{ sessionId: string; planMarkdown: string }> {
  const prompt = [
    `You are working on the project ${job.payload.repo}.`,
    `Kind: ${job.payload.kind}.`,
    `User context:`,
    job.payload.context,
    ``,
    `Write a thorough implementation plan to PLAN.md and then stop.`
  ].join("\n");

  const stdout = execSync(`opencode run --agent plan ${JSON.stringify(prompt)}`, {
    cwd: worktreeDir,
    encoding: "utf-8",
    timeout: 300_000,
  });

  const sessionMatch = stdout.match(/Session:\s*(\S+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : `session-${Date.now()}`;

  let planMarkdown = "";
  try {
    planMarkdown = readFileSync(`${worktreeDir}/PLAN.md`, "utf-8");
  } catch {
    planMarkdown = "Plan file not found. See opencode output above.";
  }

  return { sessionId, planMarkdown };
}

export async function revise(
  suggestion: string,
  sessionId: string,
  worktreeDir: string,
): Promise<{ sessionId: string; planMarkdown: string }> {
  const stdout = execSync(
    `opencode run --session ${sessionId} --continue ${JSON.stringify(suggestion)}`,
    {
      cwd: worktreeDir,
      encoding: "utf-8",
      timeout: 300_000,
    },
  );

  const sessionMatch = stdout.match(/Session:\s*(\S+)/);
  const newSessionId = sessionMatch ? sessionMatch[1] : `session-${Date.now()}`;

  let planMarkdown = "";
  try {
    planMarkdown = readFileSync(`${worktreeDir}/PLAN.md`, "utf-8");
  } catch {
    planMarkdown = "Plan file not found after revision.";
  }

  return { sessionId: newSessionId, planMarkdown };
}

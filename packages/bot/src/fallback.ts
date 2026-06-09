import { prisma } from "./db";
import { ThreadStatus, JobStatus, type JobPayload } from "@discord-agent/shared";
import { execSync } from "node:child_process";

const clientPromise: { current: import("discord.js").Client | null } = { current: null };

export function setFallbackClient(client: import("discord.js").Client) {
  clientPromise.current = client;
}

export async function handleFallback(
  jobId: string,
  payload: JobPayload,
  threadId: string,
) {
  const model = process.env.FALLBACK_MODEL || "opencode/big-pickle";
  const githubRepo = process.env.FALLBACK_REPO;

  if (!githubRepo) {
    await postToThread(threadId, "❌ Fallback requires `FALLBACK_REPO` env var to be set.");
    await failJob(jobId, threadId);
    return;
  }

  const prompt = [
    `You are working on the repository ${githubRepo}.`,
    `Kind: ${payload.kind}.`,
    `User context:`,
    payload.context,
    ``,
    `Output a structured GitHub issue (title + body) in JSON with keys "title" and "body".`,
    `Do not include any other text.`,
  ].join("\n");

  try {
    const stdout = execSync(
      `opencode run --model ${model} ${JSON.stringify(prompt)}`,
      { encoding: "utf-8", timeout: 120_000 },
    );

    const jsonMatch = stdout.match(/\{[\s\S]*"title"[\s\S]*"body"[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Could not parse JSON from opencode output");

    const { title, body } = JSON.parse(jsonMatch[0]);

    const issueUrl = execSync(
      `gh issue create -R ${githubRepo} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --label ${payload.kind.toLowerCase()}`,
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();

    const issueMatch = issueUrl.match(/(\d+)$/);
    const issueNumber = issueMatch ? issueMatch[1] : "?";

    execSync(
      `gh issue comment ${issueNumber} -R ${githubRepo} --body "/opencode fix this issue in a PR"`,
      { timeout: 30_000 },
    );

    await postToThread(
      threadId,
      `✅ Issue created: ${issueUrl}\n✅ opencode GitHub agent triggered. Watch for a PR.`,
    );

    await prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.DONE },
    });
    await prisma.thread.update({
      where: { id: threadId },
      data: { status: ThreadStatus.DONE },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await postToThread(threadId, `❌ Fallback failed: ${errorMessage}`);
    await failJob(jobId, threadId);
  }
}

async function failJob(jobId: string, threadId: string) {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.FAILED },
  });
  await prisma.thread.update({
    where: { id: threadId },
    data: { status: ThreadStatus.FAILED },
  });
}

async function postToThread(threadId: string, content: string) {
  const client = clientPromise.current;
  if (!client) return;

  const channel = client.channels.cache.get(threadId);
  if (channel?.isThread()) {
    await channel.send(content);
  }
}

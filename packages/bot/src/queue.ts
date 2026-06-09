import { prisma } from "./db";
import { JobStatus, ThreadStatus, type ClaimResponse } from "@discord-agent/shared";

const clientPromise: { current: import("discord.js").Client | null } = { current: null };

export function setQueueClient(client: import("discord.js").Client) {
  clientPromise.current = client;
}

const EMOJI: Record<string, string> = {
  info: "ℹ️",
  success: "✅",
  error: "❌",
};

export async function handleHeartbeat(workerId: string) {
  const now = new Date();

  await prisma.worker.upsert({
    where: { id: workerId },
    create: { id: workerId, lastSeen: now, status: "ONLINE" },
    update: { lastSeen: now, status: "ONLINE" },
  });

  const stale = await prisma.worker.findMany({
    where: {
      status: "ONLINE",
      lastSeen: { lt: new Date(Date.now() - 60_000) },
    },
  });

  for (const w of stale) {
    await prisma.worker.update({
      where: { id: w.id },
      data: { status: "OFFLINE" },
    });
  }
}

export async function handlePollNextJob(workerId: string): Promise<ClaimResponse> {
  await handleHeartbeat(workerId);

  const job = await prisma.job.findFirst({
    where: {
      status: JobStatus.PENDING,
      claimedBy: null,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!job) {
    return { job: null };
  }

  let payload;
  try {
    payload = JSON.parse(job.payload);
  } catch {
    return { job: null };
  }

  const branch = `fix/${payload.kind?.toLowerCase() ?? "task"}-${job.id.slice(0, 6)}`;

  await prisma.job.update({
    where: { id: job.id },
    data: {
      claimedBy: workerId,
      status: JobStatus.CLAIMED,
      worktreeBranch: branch,
    },
  });

  return {
    job: {
      id: job.id,
      payload,
      worktreeBranch: branch,
      status: JobStatus.CLAIMED,
    },
  };
}

export async function handlePostStatus(input: {
  jobId: string;
  message: string;
  level?: "info" | "success" | "error";
  prUrl?: string;
  issueUrl?: string;
}) {
  const client = clientPromise.current;
  if (!client) return { ok: true };

  const job = await prisma.job.findUnique({ where: { id: input.jobId } });
  if (!job) return { ok: true };

  const channel = client.channels.cache.get(job.threadId);
  if (!channel || !channel.isThread()) return { ok: true };

  const emoji = EMOJI[input.level ?? "info"] ?? "ℹ️";
  let content = `${emoji} ${input.message}`;

  if (input.prUrl) content += `\n🔗 PR: ${input.prUrl}`;
  if (input.issueUrl) content += `\n🔗 Issue: ${input.issueUrl}`;

  await channel.send(content);

  if (input.prUrl) {
    await prisma.job.update({
      where: { id: input.jobId },
      data: { status: JobStatus.DONE },
    });
    await prisma.thread.update({
      where: { id: job.threadId },
      data: { status: ThreadStatus.DONE },
    });
  }

  return { ok: true };
}

export async function handlePlanReady(input: {
  jobId: string;
  planMarkdown: string;
  sessionId: string;
}) {
  const client = clientPromise.current;
  if (!client) return { ok: true };

  const job = await prisma.job.findUnique({ where: { id: input.jobId } });
  if (!job) return { ok: true };

  await prisma.job.update({
    where: { id: input.jobId },
    data: {
      planSessionId: input.sessionId,
      status: JobStatus.AWAITING_APPROVAL,
    },
  });
  await prisma.thread.update({
    where: { id: job.threadId },
    data: { status: ThreadStatus.AWAITING_APPROVAL },
  });

  const channel = client.channels.cache.get(job.threadId);
  if (!channel || !channel.isThread()) return { ok: true };

  const chunks = chunkText(input.planMarkdown, 1900);
  for (const chunk of chunks) {
    await channel.send("```markdown\n" + chunk + "\n```");
  }

  const thread = await prisma.thread.findUnique({ where: { id: job.threadId } });
  const isAuto = thread?.autoMode ?? false;

  if (isAuto) {
    await channel.send({
      content: "🤖 Auto mode — building in 10s…",
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: "Cancel",
              custom_id: `cancel:${input.jobId}`,
            },
          ],
        },
      ],
    });

    setTimeout(async () => {
      await prisma.job.update({
        where: { id: input.jobId },
        data: { status: JobStatus.BUILDING },
      });
      await prisma.thread.update({
        where: { id: job.threadId },
        data: { status: ThreadStatus.BUILDING },
      });

      const { approvalMap } = await import("./interactions");
      approvalMap.set(input.jobId, { approved: true, cancelled: false });
    }, 10_000);
  } else {
    await channel.send({
      content: "Review the plan above and choose:",
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "Approve",
              custom_id: `approve:${input.jobId}`,
            },
            {
              type: 2,
              style: 2,
              label: "Suggest changes",
              custom_id: `suggest:${input.jobId}`,
            },
            {
              type: 2,
              style: 4,
              label: "Cancel",
              custom_id: `cancel:${input.jobId}`,
            },
          ],
        },
      ],
    });
  }

  return { ok: true };
}

export async function handleApprovePlan(input: { jobId: string; approved: boolean }) {
  const { approvalMap } = await import("./interactions");
  approvalMap.set(input.jobId, {
    approved: input.approved,
    cancelled: !input.approved,
  });

  if (input.approved) {
    await prisma.job.update({
      where: { id: input.jobId },
      data: { status: JobStatus.BUILDING },
    });
  } else {
    await prisma.job.update({
      where: { id: input.jobId },
      data: { status: JobStatus.CANCELLED },
    });
  }

  return { ok: true };
}

export async function handleSuggestChange(input: {
  jobId: string;
  text: string;
  sessionId: string;
}) {
  const { approvalMap } = await import("./interactions");
  approvalMap.set(input.jobId, {
    approved: false,
    cancelled: false,
    suggestion: { text: input.text, sessionId: input.sessionId },
  });

  return { ok: true };
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxLen));
    start += maxLen;
  }
  return chunks;
}

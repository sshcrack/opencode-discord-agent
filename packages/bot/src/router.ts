import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import {
  HeartbeatSchema,
  StatusUpdateSchema,
  PlanReadySchema,
  ApprovalSchema,
  SuggestionSchema,
  ClaimResponseSchema,
  JobStatus,
  ThreadStatus,
} from "@discord-agent/shared";
import { prisma } from "./db";
import { ChannelType, type Client } from "discord.js";

const clientPromise: { current: Client | null } = { current: null };

export function setDiscordClient(client: Client) {
  clientPromise.current = client;
}

const EMOJI: Record<string, string> = {
  info: "\u2139\ufe0f",
  success: "\u2705",
  error: "\u274c",
};

export const createContext = (opts: CreateHTTPContextOptions) => {
  const auth = opts.req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  return { bearer, res: opts.res };
};

const t = initTRPC.context<typeof createContext>().create();

const authMiddleware = t.middleware(({ ctx, next }) => {
  const secret = process.env.WORKER_SECRET;
  if (secret && ctx.bearer !== secret) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx });
});

const procedure = t.procedure.use(authMiddleware);

// --- heartbeat ---

async function handleHeartbeat(workerId: string) {
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
    await prisma.worker.update({ where: { id: w.id }, data: { status: "OFFLINE" } });
  }
}

// --- poll next job ---

async function handlePollNextJob(workerId: string) {
  await handleHeartbeat(workerId);

  const job = await prisma.job.findFirst({
    where: { status: JobStatus.PENDING, claimedBy: null },
    orderBy: { createdAt: "asc" },
  });

  if (!job) return { job: null };

  let payload: any;
  try { payload = JSON.parse(job.payload); } catch { return { job: null }; }

  const repoRecord = await prisma.repository.findUnique({ where: { name: payload.repo } });
  if (!repoRecord) {
    await prisma.job.update({ where: { id: job.id }, data: { status: JobStatus.FAILED } });
    return { job: null };
  }

  const branch = `fix/${payload.kind?.toLowerCase() ?? "task"}-${job.id.slice(0, 6)}`;

  await prisma.job.update({
    where: { id: job.id },
    data: { claimedBy: workerId, status: JobStatus.CLAIMED, worktreeBranch: branch },
  });

  return {
    job: { id: job.id, payload, worktreeBranch: branch, status: JobStatus.CLAIMED, repoPath: repoRecord.path },
  };
}

// --- post status ---

async function handlePostStatus(input: {
  jobId: string; message: string; level?: "info" | "success" | "error"; prUrl?: string; issueUrl?: string;
}) {
  const client = clientPromise.current;
  if (!client) return { ok: true };

  const job = await prisma.job.findUnique({ where: { id: input.jobId } });
  if (!job) return { ok: true };

  const channel = client.channels.cache.get(job.threadId);
  if (!channel?.isThread()) return { ok: true };

  const emoji = EMOJI[input.level ?? "info"] ?? "\u2139\ufe0f";
  let content = `${emoji} ${input.message}`;
  if (input.prUrl) content += `\n\ud83d\udd17 PR: ${input.prUrl}`;
  if (input.issueUrl) content += `\n\ud83d\udd17 Issue: ${input.issueUrl}`;

  await channel.send(content);

  if (input.prUrl) {
    await prisma.job.update({ where: { id: input.jobId }, data: { status: JobStatus.DONE } });
    const j = await prisma.job.findUnique({ where: { id: input.jobId } });
    if (j) await prisma.thread.update({ where: { id: j.threadId }, data: { status: ThreadStatus.DONE } });
  }

  return { ok: true };
}

// --- plan ready ---

async function handlePlanReady(input: { jobId: string; planMarkdown: string; sessionId: string }) {
  const client = clientPromise.current;
  if (!client) return { ok: true };

  const job = await prisma.job.findUnique({ where: { id: input.jobId } });
  if (!job) return { ok: true };

  await prisma.job.update({
    where: { id: input.jobId },
    data: { planSessionId: input.sessionId, status: JobStatus.AWAITING_APPROVAL },
  });
  await prisma.thread.update({ where: { id: job.threadId }, data: { status: ThreadStatus.AWAITING_APPROVAL } });

  const channel = client.channels.cache.get(job.threadId);
  if (!channel?.isThread()) return { ok: true };

  for (const chunk of chunkText(input.planMarkdown, 1900)) {
    await channel.send("```markdown\n" + chunk + "\n```");
  }

  const thread = await prisma.thread.findUnique({ where: { id: job.threadId } });
  const isAuto = thread?.autoMode ?? false;

  if (isAuto) {
    await channel.send({
      content: "\ud83e\udd16 Auto mode — building in 10s…",
      components: [{ type: 1, components: [{ type: 2, style: 4, label: "Cancel", custom_id: `cancel:${input.jobId}` }] }],
    });

    setTimeout(async () => {
      await prisma.job.update({ where: { id: input.jobId }, data: { status: JobStatus.BUILDING } });
      await prisma.thread.update({ where: { id: job.threadId }, data: { status: ThreadStatus.BUILDING } });
      approvalMap.set(input.jobId, { approved: true, cancelled: false });
    }, 10_000);
  } else {
    await channel.send({
      content: "Review the plan above and choose:",
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: "Approve", custom_id: `approve:${input.jobId}` },
          { type: 2, style: 2, label: "Suggest changes", custom_id: `suggest:${input.jobId}` },
          { type: 2, style: 4, label: "Cancel", custom_id: `cancel:${input.jobId}` },
        ],
      }],
    });
  }

  return { ok: true };
}

// --- approve / suggest / cancel (used by both tRPC and button handler) ---

export const approvalMap = new Map<
  string,
  { approved: boolean; cancelled: boolean; suggestion?: { text: string; sessionId: string } }
>();

async function handleApprovePlan(input: { jobId: string; approved: boolean }) {
  approvalMap.set(input.jobId, { approved: input.approved, cancelled: !input.approved });
  await prisma.job.update({
    where: { id: input.jobId },
    data: { status: input.approved ? JobStatus.BUILDING : JobStatus.CANCELLED },
  });
  return { ok: true };
}

async function handleSuggestChange(input: { jobId: string; text: string; sessionId: string }) {
  approvalMap.set(input.jobId, {
    approved: false, cancelled: false,
    suggestion: { text: input.text, sessionId: input.sessionId },
  });
  return { ok: true };
}

// --- router definition ---

export const appRouter = t.router({
  heartbeat: procedure.input(HeartbeatSchema).mutation(async ({ input }) => {
    await handleHeartbeat(input.workerId);
    return { ok: true };
  }),

  pollNextJob: procedure.input(HeartbeatSchema).output(ClaimResponseSchema).query(async ({ input }) => {
    return handlePollNextJob(input.workerId);
  }),

  postStatus: procedure.input(StatusUpdateSchema).mutation(async ({ input }) => {
    return handlePostStatus(input);
  }),

  planReady: procedure.input(PlanReadySchema).mutation(async ({ input }) => {
    return handlePlanReady(input);
  }),

  approvePlan: procedure.input(ApprovalSchema).mutation(async ({ input }) => {
    return handleApprovePlan(input);
  }),

  suggestChange: procedure.input(SuggestionSchema).mutation(async ({ input }) => {
    return handleSuggestChange(input);
  }),
});

export type AppRouter = typeof appRouter;

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxLen) {
    chunks.push(text.slice(start, start + maxLen));
  }
  return chunks;
}

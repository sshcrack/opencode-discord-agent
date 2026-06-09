import { initTRPC } from "@trpc/server";
import {
  PollNextJobInput,
  PlanReadyInput,
  PostStatusInput,
  ApproveJobInput,
  CancelJobInput,
  SuggestChangesInput,
  JobSchema,
  StatusResult,
} from "@opencode-discord/shared";
import { prisma } from "../db";
import { postToThread } from "../discord/helpers";
import { postPlan } from "../discord/plan";
import type { ReportKind } from "@opencode-discord/shared";

const t = initTRPC.create();

function toJobOutput(job: any) {
  return {
    id: job.id,
    threadId: job.threadId,
    repoSlug: job.repoSlug,
    repoPath: job.repoPath ?? "",
    kind: job.kind as ReportKind,
    status: job.status,
    workerId: job.workerId,
    planMd: job.planMd,
    opencodeSessionId: job.opencodeSessionId,
    issueNumber: job.issueNumber,
    prUrl: job.prUrl,
    autoMode: job.autoMode,
  };
}

export const appRouter = t.router({
  pollNextJob: t.procedure
    .input(PollNextJobInput)
    .output(JobSchema.nullable())
    .query(async ({ input }) => {
      const now = new Date();
      await prisma.setting.upsert({
        where: { key: `worker:${input.workerId}:lastSeen` },
        update: { value: now.toISOString() },
        create: { key: `worker:${input.workerId}:lastSeen`, value: now.toISOString() },
      });

      const job = await prisma.job.findFirst({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
      });

      if (!job) return null;

      const repo = await prisma.repository.findUnique({ where: { slug: job.repoSlug } });

      await prisma.job.update({
        where: { id: job.id },
        data: { status: "claimed", workerId: input.workerId },
      });

      await postToThread(job.threadId, `:information_source: Worker **${input.workerId}** picked up the job`);

      return toJobOutput({ ...job, repoPath: repo?.path ?? "" });
    }),

  planReady: t.procedure
    .input(PlanReadyInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.update({
        where: { id: input.jobId },
        data: { status: "plan_ready", planMd: input.planMd, opencodeSessionId: input.sessionId },
      });

      return await postPlan(toJobOutput(job), input.planMd);
    }),

  postStatus: t.procedure
    .input(PostStatusInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      const emoji = input.level === "info" ? ":information_source:" : input.level === "success" ? ":white_check_mark:" : ":x:";
      await postToThread(job.threadId, `${emoji} ${input.message}`);

      return { success: true };
    }),

  approveJob: t.procedure
    .input(ApproveJobInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      await prisma.job.update({
        where: { id: input.jobId },
        data: { status: "approved" },
      });
      return { success: true };
    }),

  cancelJob: t.procedure
    .input(CancelJobInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (job) {
        await prisma.job.update({
          where: { id: input.jobId },
          data: { status: "cancelled" },
        });
        await postToThread(job.threadId, ":x: Job cancelled");
      }
      return { success: true };
    }),

  suggestChanges: t.procedure
    .input(SuggestChangesInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      await prisma.job.update({
        where: { id: input.jobId },
        data: { status: "planning" },
      });

      await postToThread(job.threadId, `:arrows_counterclockwise: Plan revision requested: "${input.suggestion}"`);

      return { success: true };
    }),
});

export type AppRouter = typeof appRouter;

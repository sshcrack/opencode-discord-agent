import { initTRPC } from "@trpc/server";
import {
  PollNextJobInput,
  GetJobStatusInput,
  PlanReadyInput,
  PostStatusInput,
  ApproveJobInput,
  CancelJobInput,
  SuggestChangesInput,
  AckSuggestionInput,
  SetIssueNumberInput,
  JobSchema,
  StatusResult,
  GetSettingInput,
  GetSettingOutput,
} from "@opencode-discord/shared";
import { prisma } from "../db";
import { postToThread } from "../discord/helpers";
import { postPlan } from "../discord/plan";
import type { Job } from "../db/generated/client";

function toJobOutput(job: Job) {
  return {
    id: job.id,
    threadId: job.threadId,
    repoSlug: job.repoSlug,
    repoPath: job.repoPath,
    kind: job.kind,
    status: job.status,
    context: job.context,
    workerId: job.workerId,
    planMd: job.planMd,
    opencodeSessionId: job.opencodeSessionId,
    issueNumber: job.issueNumber,
    prUrl: job.prUrl,
    autoMode: job.autoMode,
    pendingSuggestion: job.pendingSuggestion,
  };
}

const t = initTRPC.create();

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

      // Atomically claim a pending job — the where clause prevents two workers
      // from claiming the same job
      const claimed = await prisma.$transaction(async (tx) => {
        const job = await tx.job.findFirst({
          where: { status: "pending" },
          orderBy: { createdAt: "asc" },
        });
        if (!job) return null;

        const repo = await tx.repository.findUnique({ where: { slug: job.repoSlug } });

        return tx.job.update({
          where: { id: job.id, status: "pending" },
          data: {
            status: "claimed",
            workerId: input.workerId,
            repoPath: repo?.path ?? "",
          },
        });
      });

      if (!claimed) return null;

      await postToThread(
        claimed.threadId,
        `ℹ️ Worker **${input.workerId}** picked up the job`,
      );

      return toJobOutput(claimed);
    }),

  getJobStatus: t.procedure
    .input(GetJobStatusInput)
    .output(JobSchema.nullable())
    .query(async ({ input }) => {
      const now = new Date();
      await prisma.setting.upsert({
        where: { key: `worker:${input.workerId}:lastSeen` },
        update: { value: now.toISOString() },
        create: { key: `worker:${input.workerId}:lastSeen`, value: now.toISOString() },
      });

      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return null;
      return toJobOutput(job);
    }),

  planReady: t.procedure
    .input(PlanReadyInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      // Only allow transitioning from claimed or planning
      if (job.status !== "claimed" && job.status !== "planning") {
        return { success: false };
      }

      const updated = await prisma.job.update({
        where: { id: input.jobId },
        data: {
          status: "plan_ready",
          planMd: input.planMd,
          opencodeSessionId: input.sessionId,
        },
      });

      return await postPlan(toJobOutput(updated), input.planMd);
    }),

  postStatus: t.procedure
    .input(PostStatusInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      const verboseSetting = await prisma.setting.findUnique({ where: { key: "verbose_mode" } });
      const verbose = verboseSetting?.value !== "off";

      if (input.level === "info" && !verbose) return { success: true };

      const emoji =
        input.level === "info" ? "ℹ️" : input.level === "success" ? "✅" : "❌";
      await postToThread(job.threadId, `${emoji} ${input.message}`);

      return { success: true };
    }),

  approveJob: t.procedure
    .input(ApproveJobInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const result = await prisma.job.updateMany({
        where: { id: input.jobId, status: "plan_ready" },
        data: { status: "approved" },
      });
      return { success: result.count > 0 };
    }),

  cancelJob: t.procedure
    .input(CancelJobInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      // Don't cancel already-terminal jobs
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
        return { success: false };
      }

      await prisma.job.update({
        where: { id: input.jobId },
        data: { status: "cancelled" },
      });
      await postToThread(job.threadId, "❌ Job cancelled");
      return { success: true };
    }),

  suggestChanges: t.procedure
    .input(SuggestChangesInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      if (job.status !== "plan_ready") return { success: false };

      await prisma.job.update({
        where: { id: input.jobId },
        data: { status: "planning", pendingSuggestion: input.suggestion },
      });

      await postToThread(
        job.threadId,
        `🔄 Plan revision requested: "${input.suggestion}"`,
      );

      return { success: true };
    }),

  ackSuggestion: t.procedure
    .input(AckSuggestionInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const result = await prisma.job.updateMany({
        where: { id: input.jobId, status: "planning" },
        data: { pendingSuggestion: null },
      });
      return { success: result.count > 0 };
    }),

  getSetting: t.procedure
    .input(GetSettingInput)
    .output(GetSettingOutput)
    .query(async ({ input }) => {
      const setting = await prisma.setting.findUnique({ where: { key: input.key } });
      return { value: setting?.value ?? null };
    }),

  setIssueNumber: t.procedure
    .input(SetIssueNumberInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };
      await prisma.job.update({
        where: { id: input.jobId },
        data: { issueNumber: input.issueNumber },
      });
      return { success: true };
    }),
});

export type AppRouter = typeof appRouter;

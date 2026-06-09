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
  JobSchema,
  StatusResult,
  GetSettingInput,
  GetSettingOutput,
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
    context: job.context ?? null,
    workerId: job.workerId,
    planMd: job.planMd,
    opencodeSessionId: job.opencodeSessionId,
    issueNumber: job.issueNumber,
    prUrl: job.prUrl,
    autoMode: job.autoMode,
    pendingSuggestion: job.pendingSuggestion ?? null,
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

      // Resolve repo path at claim time and store it on the job
      const repo = await prisma.repository.findUnique({ where: { slug: job.repoSlug } });

      const claimed = await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "claimed",
          workerId: input.workerId,
          repoPath: repo?.path ?? "",
        },
      });

      await postToThread(
        job.threadId,
        `ℹ️ Worker **${input.workerId}** picked up the job`,
      );

      return toJobOutput(claimed);
    }),

  getJobStatus: t.procedure
    .input(GetJobStatusInput)
    .output(JobSchema.nullable())
    .query(async ({ input }) => {
      // Also serve as a heartbeat
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
      const job = await prisma.job.update({
        where: { id: input.jobId },
        data: {
          status: "plan_ready",
          planMd: input.planMd,
          opencodeSessionId: input.sessionId,
        },
      });

      return await postPlan(toJobOutput(job), input.planMd);
    }),

  postStatus: t.procedure
    .input(PostStatusInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      const verboseSetting = await prisma.setting.findUnique({ where: { key: "verbose_mode" } });
      const verbose = verboseSetting?.value !== "off";

      // Always post success/error; only post info when verbose
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
        await postToThread(job.threadId, "❌ Job cancelled");
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
      await prisma.job.update({
        where: { id: input.jobId },
        data: { pendingSuggestion: null },
      });
      return { success: true };
    }),

  getSetting: t.procedure
    .input(GetSettingInput)
    .output(GetSettingOutput)
    .query(async ({ input }) => {
      const setting = await prisma.setting.findUnique({ where: { key: input.key } });
      return { value: setting?.value ?? null };
    }),
});

export type AppRouter = typeof appRouter;

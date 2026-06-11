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
  RenameThreadInput,
  MarkCompleteInput,
  JobSchema,
  StatusResult,
  GetSettingInput,
  GetSettingOutput,
  TypingInput,
  AskQuestionInput,
  PollAnswerInput,
  PollAnswerOutput,
  GetBotHeadOutput,
  PollNextJobOutput,
} from "@opencode-discord/shared";
import { prisma } from "../db";
import { postToThread, renameThread, getClient } from "../discord/helpers";
import { postPlan } from "../discord/plan";
import { showNextQuestion, recordAnswer, formatQaBlock } from "../discord/questions";
import type { Job } from "../db/generated/client";
import { TextChannel, ThreadChannel } from "discord.js";

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
    reporterId: job.reporterId,
    planMd: job.planMd,
    opencodeSessionId: job.opencodeSessionId,
    issueNumber: job.issueNumber,
    prUrl: job.prUrl,
    autoMode: job.autoMode,
    pendingSuggestion: job.pendingSuggestion,
    planEditToken: job.planEditToken ?? null,
    pendingQuestions: job.pendingQuestions ?? null,
    pendingQuestionIndex: job.pendingQuestionIndex ?? null,
    pendingAnswers: job.pendingAnswers ?? null,
  };
}

const t = initTRPC.create();

export const appRouter = t.router({
  pollNextJob: t.procedure
    .input(PollNextJobInput)
    .output(PollNextJobOutput)
    .query(async ({ input }) => {
      const now = new Date();
      await prisma.setting.upsert({
        where: { key: `worker:${input.workerId}:lastSeen` },
        update: { value: now.toISOString() },
        create: { key: `worker:${input.workerId}:lastSeen`, value: now.toISOString() },
      });

      // Verify worker is on the same git HEAD as the bot
      const botHead = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
      if (botHead && botHead !== "unknown" && input.gitHead !== botHead) {
        return { jobs: [], gitMismatch: true };
      }

      const pending = await prisma.job.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
      });

      const claimed = [];
      for (const job of pending) {
        const repo = await prisma.repository.findUnique({ where: { slug: job.repoSlug } });
        const updated = await prisma.job.update({
          where: { id: job.id, status: "pending" },
          data: { status: "claimed", workerId: input.workerId, repoPath: repo?.path ?? "" },
        });
        if (updated) {
          claimed.push(toJobOutput(updated));
          await postToThread(updated.threadId, `ℹ️ Worker **${input.workerId}** picked up the job`);
        }
      }

      return { jobs: claimed, gitMismatch: false };
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

      // Debug messages only show when verbose is on
      if (input.level === "debug" && !verbose) return { success: true };
      // Info messages hidden when verbose is off
      if (input.level === "info" && !verbose) return { success: true };

      const emoji =
        input.level === "info" ? "ℹ️" :
        input.level === "success" ? "✅" :
        input.level === "debug" ? "🔍" : "❌";

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

  renameJobThread: t.procedure
    .input(RenameThreadInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };
      await renameThread(job.threadId, input.name);
      return { success: true };
    }),

  typing: t.procedure
    .input(TypingInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      try {
        const channel = await getClient().channels.fetch(input.threadId);
        if (channel?.isTextBased()) {
          await (channel as TextChannel | ThreadChannel).sendTyping();
        }
        return { success: true };
      } catch {
        return { success: false };
      }
    }),

  markComplete: t.procedure
    .input(MarkCompleteInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      await prisma.job.update({
        where: { id: input.jobId },
        data: {
          status: "done",
          prUrl: input.prUrl,
        },
      });

      await postToThread(job.threadId, `✅ PR created: ${input.prUrl}`);
      await postToThread(job.threadId, `✅ Job complete! <@${job.reporterId}> your PR is ready!`);

      return { success: true };
    }),

  askQuestion: t.procedure
    .input(AskQuestionInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      await prisma.job.update({
        where: { id: input.jobId },
        data: {
          pendingQuestions: JSON.stringify(input.questions),
          pendingQuestionIndex: 0,
          pendingAnswers: "[]",
        },
      });

      await showNextQuestion(job.threadId, job.id, input.questions, 0, job.reporterId);

      return { success: true };
    }),

  pollAnswer: t.procedure
    .input(PollAnswerInput)
    .output(PollAnswerOutput)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job || !job.pendingQuestions) return { answered: false, formatted: null };

      const questions = JSON.parse(job.pendingQuestions) as { q: string; options: string[]; recommended: number }[];
      const pendingAnswers = job.pendingAnswers ? JSON.parse(job.pendingAnswers) as { q: string; a: string }[] : [];
      const currentIdx = job.pendingQuestionIndex ?? 0;

      if (currentIdx >= questions.length) {
        const formatted = formatQaBlock(questions, pendingAnswers);
        await prisma.job.update({
          where: { id: input.jobId },
          data: {
            pendingQuestions: null,
            pendingQuestionIndex: null,
            pendingAnswers: null,
          },
        });
        return { answered: true, formatted };
      }

      return { answered: false, formatted: null };
    }),

  getBotHead: t.procedure
    .output(GetBotHeadOutput)
    .query(async () => {
      const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
      return { sha: proc.stdout.toString().trim() || "unknown" };
    }),
});

export type AppRouter = typeof appRouter;

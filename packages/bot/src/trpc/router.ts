import crypto from "node:crypto";
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
  ReleaseWorkerJobsInput,
  ReleaseWorkerJobsOutput,
  CreateReviewMergeJobInput,
  CloseJobThreadInput,
  HardworkPlansReadyInput,
  ConfirmHardworkPlanInput,
  WaitForSelectionOutput,
  SavePlanRevisionInput,
  GetPlanRevisionsInput,
  GetPlanRevisionsOutput,
  RestorePlanRevisionInput,
  SetWorktreePathInput,
  SetBranchInput,
} from "@opencode-discord/shared";
import { prisma } from "../db";
import { postToThread, postToThreadWithComponents, editMessage, fetchLastMessage, renameThread, discordFetch, closeThreadForJob } from "../discord/helpers";
import { postPlan } from "../discord/plan";
import { postHardworkPlans } from "../discord/hardwork";
import { showNextQuestion, formatQaBlock } from "../discord/questions";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Job } from "../db/generated/client";

function parseQuestions(
  data: string,
): { q: string; options: string[]; recommended: number }[] {
  return JSON.parse(data);
}

function parseAnswers(
  data: string,
): { q: string; a: string }[] {
  return JSON.parse(data);
}

function toJobOutput(job: Job) {
  return {
    id: job.id,
    threadId: job.threadId,
    repoSlug: job.repoSlug,
    repoPath: job.repoPath,
    worktreePath: job.worktreePath ?? null,
    kind: job.kind,
    status: job.status,
    context: job.context,
    workerId: job.workerId,
    reporterId: job.reporterId,
    planMd: job.planMd,
    opencodeSessionId: job.opencodeSessionId,
    buildSessionId: job.buildSessionId,
    issueNumber: job.issueNumber,
    prUrl: job.prUrl,
    branch: job.branch,
    parentJobId: job.parentJobId,
    autoMode: job.autoMode,
    quickMode: job.quickMode,
    hardwork: job.hardwork,
    parallelPlanCount: job.parallelPlanCount,
    hardworkPlans: job.hardworkPlans ?? null,
    selectedPlanIndex: job.selectedPlanIndex ?? null,
    pendingSuggestion: job.pendingSuggestion,
    planEditToken: job.planEditToken ?? null,
    pendingQuestions: job.pendingQuestions ?? null,
    pendingQuestionIndex: job.pendingQuestionIndex ?? null,
    pendingAnswers: job.pendingAnswers ?? null,
    statusMessageId: job.statusMessageId ?? null,
  };
}

const ACTIVE_STATUSES: Job["status"][] = ["claimed", "planning", "plan_ready", "approved", "building"];

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
      let botHead = "";
      try {
        const headProc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
        botHead = headProc.stdout.toString().trim();
      } catch {
        botHead = "unknown";
      }
      if (botHead && botHead !== "unknown" && input.gitHead !== botHead) {
        return { jobs: [], gitMismatch: true };
      }

      const pending = await prisma.job.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        include: { thread: true },
      });

      const claimed = [];
      for (const job of pending) {
        // Skip jobs whose thread has been closed — cancel them immediately
        if (job.thread.closedAt) {
          await prisma.job.update({
            where: { id: job.id },
            data: { status: "cancelled" },
          });
          continue;
        }

        // Only one active job per thread — skip if this thread already has one
        const existingActive = await prisma.job.findFirst({
          where: {
            threadId: job.threadId,
            status: { in: ACTIVE_STATUSES },
            id: { not: job.id },
          },
        });
        if (existingActive) continue;

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

      // Determine revision source: if planMd already existed, it's a suggestion revision
      const hadExistingPlan = !!job.planMd;
      const hadPendingSuggestion = !!job.pendingSuggestion;
      const source = hadExistingPlan && hadPendingSuggestion ? "suggestion" : "agent";

      const updated = await prisma.job.update({
        where: { id: input.jobId },
        data: {
          status: "plan_ready",
          planMd: input.planMd,
          opencodeSessionId: input.sessionId,
        },
      });

      // Auto-save a revision record
      const lastRev = await prisma.planRevision.findFirst({
        where: { jobId: input.jobId },
        orderBy: { revisionNumber: "desc" },
      });
      await prisma.planRevision.create({
        data: {
          jobId: input.jobId,
          revisionNumber: (lastRev?.revisionNumber ?? 0) + 1,
          planMd: input.planMd,
          source,
        },
      }).catch(() => {});

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

      const emoji =
        input.level === "info" ? "ℹ️" :
        input.level === "success" ? "✅" :
        input.level === "debug" ? "🔍" : "❌";

      const fullMessage = input.diff
        ? `${emoji} ${input.message}\n\`\`\`diff\n${input.diff}\n\`\`\``
        : `${emoji} ${input.message}`;

      const mode = input.mode ?? "new";
      const messageId = job.statusMessageId;

      if (mode === "replace" && messageId) {
        const edited = await editMessage(job.threadId, messageId, fullMessage).catch(() => false);
        if (edited) return { success: true };
      }

      if (mode === "append" && messageId) {
        const edited = await editMessage(job.threadId, messageId, fullMessage).catch(() => false);
        if (edited) return { success: true };
      }

      // Fall through to posting a new message
      await postToThread(job.threadId, fullMessage).catch(() => {});

      // Track the last status message ID for future replace/append operations
      const lastId = await fetchLastMessage(job.threadId).catch(() => null);
      if (lastId && lastId !== messageId) {
        await prisma.job.update({
          where: { id: input.jobId },
          data: { statusMessageId: lastId },
        }).catch(() => {});
      }

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
        const channel = await discordFetch(input.threadId);
        if (channel?.isThread()) {
          await channel.sendTyping();
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
          buildSessionId: input.buildSessionId,
          branch: input.branch,
        },
      });

      await postToThread(job.threadId, `✅ PR created: ${input.prUrl}`);
      await postToThread(job.threadId, `✅ Job complete! <@${job.reporterId}> your PR is ready!`);

      if (input.prUrl) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`review_merge:${job.id}`)
            .setLabel("Review & Merge")
            .setStyle(ButtonStyle.Primary)
            .setEmoji("🔍"),
          new ButtonBuilder()
            .setCustomId(`merge_now:${job.id}`)
            .setLabel("Merge now")
            .setStyle(ButtonStyle.Success)
            .setEmoji("🚀"),
        );
        await postToThreadWithComponents(job.threadId, row);
      }

      return { success: true };
    }),

  closeJobThread: t.procedure
    .input(CloseJobThreadInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };
      await closeThreadForJob(job);
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

      const questions = parseQuestions(job.pendingQuestions);
      const pendingAnswers = job.pendingAnswers ? parseAnswers(job.pendingAnswers) : [];
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
      let sha = "unknown";
      try {
        const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
        sha = proc.stdout.toString().trim() || "unknown";
      } catch {
        sha = "unknown";
      }
      return { sha };
    }),

  createReviewMergeJob: t.procedure
    .input(CreateReviewMergeJobInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const parentJob = await prisma.job.findUnique({ where: { id: input.parentJobId } });
      if (!parentJob || !parentJob.prUrl) return { success: false };

      const reportThread = await prisma.reportThread.findUnique({ where: { threadId: input.threadId } });
      if (reportThread?.closedAt) return { success: false };

      await prisma.job.create({
        data: {
          threadId: input.threadId,
          repoSlug: parentJob.repoSlug,
          kind: "other",
          status: "pending",
          context: "review-merge",
          autoMode: true,
          quickMode: true,
          parentJobId: input.parentJobId,
        },
      });

      return { success: true };
    }),

  hardworkPlansReady: t.procedure
    .input(HardworkPlansReadyInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      const updated = await prisma.job.update({
        where: { id: input.jobId },
        data: {
          status: "plan_ready",
          hardworkPlans: JSON.stringify(input.plans),
          planMd: input.synthesizedPlanMd,
          opencodeSessionId: input.sessionId,
        },
      });

      if (updated.autoMode) {
        return await postPlan(toJobOutput(updated), input.synthesizedPlanMd);
      }

      await postHardworkPlans(toJobOutput(updated), input.plans, input.synthesizedPlanMd);
      return { success: true };
    }),

  confirmHardworkPlan: t.procedure
    .input(ConfirmHardworkPlanInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { success: false };

      if (job.status !== "plan_ready" || !job.hardwork) {
        return { success: false };
      }

      let plans: { index: number; planMd: string; label: string }[] = [];
      try {
        plans = JSON.parse(job.hardworkPlans ?? "[]");
      } catch {
        return { success: false };
      }

      const selected = plans.find(p => p.index === input.planIndex);
      if (!selected) return { success: false };

      await prisma.job.update({
        where: { id: input.jobId },
        data: {
          selectedPlanIndex: input.planIndex,
          planMd: selected.planMd,
        },
      });

      // Auto-save a revision for the selected hardwork plan
      const lastRev = await prisma.planRevision.findFirst({
        where: { jobId: input.jobId },
        orderBy: { revisionNumber: "desc" },
      });
      await prisma.planRevision.create({
        data: {
          jobId: input.jobId,
          revisionNumber: (lastRev?.revisionNumber ?? 0) + 1,
          planMd: selected.planMd,
          source: "hardwork",
        },
      }).catch(() => {});

      return { success: true };
    }),

  waitForHardworkSelection: t.procedure
    .input(GetJobStatusInput)
    .output(WaitForSelectionOutput)
    .query(async ({ input }) => {
      const job = await prisma.job.findUnique({ where: { id: input.jobId } });
      if (!job) return { selected: false, planMd: null, planIndex: null };

      return {
        selected: job.selectedPlanIndex !== null,
        planMd: job.planMd,
        planIndex: job.selectedPlanIndex,
      };
    }),

  releaseWorkerJobs: t.procedure
    .input(ReleaseWorkerJobsInput)
    .output(ReleaseWorkerJobsOutput)
    .mutation(async ({ input }) => {
      const result = await prisma.job.updateMany({
        where: {
          workerId: input.workerId,
          status: { in: ACTIVE_STATUSES },
        },
        data: {
          status: "pending",
          workerId: null,
          // Intentionally NOT clearing: planMd, opencodeSessionId, buildSessionId,
          // hardworkPlans, selectedPlanIndex, branch, worktreePath — these are
          // durable progress checkpoints used to resume correctly after a restart.
          pendingSuggestion: null,
          planEditToken: null,
          pendingQuestions: null,
          pendingQuestionIndex: null,
          pendingAnswers: null,
          statusMessageId: null,
        },
      });
      return { released: result.count };
    }),

  savePlanRevision: t.procedure
    .input(SavePlanRevisionInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const last = await prisma.planRevision.findFirst({
        where: { jobId: input.jobId },
        orderBy: { revisionNumber: "desc" },
      });
      const revisionNumber = (last?.revisionNumber ?? 0) + 1;
      await prisma.planRevision.create({
        data: {
          jobId: input.jobId,
          revisionNumber,
          planMd: input.planMd,
          source: input.source,
        },
      });
      return { success: true };
    }),

  getPlanRevisions: t.procedure
    .input(GetPlanRevisionsInput)
    .output(GetPlanRevisionsOutput)
    .query(async ({ input }) => {
      const revisions = await prisma.planRevision.findMany({
        where: { jobId: input.jobId },
        orderBy: { revisionNumber: "desc" },
      });
      return { revisions };
    }),

  restorePlanRevision: t.procedure
    .input(RestorePlanRevisionInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      const revision = await prisma.planRevision.findUnique({
        where: { jobId_revisionNumber: { jobId: input.jobId, revisionNumber: input.revisionNumber } },
      });
      if (!revision) return { success: false };

      const token = crypto.randomUUID();

      await prisma.job.update({
        where: { id: input.jobId },
        data: {
          planMd: revision.planMd,
          planEditToken: token,
        },
      });

      // Save a revision entry recording the restore
      const last = await prisma.planRevision.findFirst({
        where: { jobId: input.jobId },
        orderBy: { revisionNumber: "desc" },
      });
      const revisionNumber = (last?.revisionNumber ?? 0) + 1;
      await prisma.planRevision.create({
        data: {
          jobId: input.jobId,
          revisionNumber,
          planMd: revision.planMd,
          source: "restored",
        },
      });

      return { success: true };
    }),

  setWorktreePath: t.procedure
    .input(SetWorktreePathInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      await prisma.job.update({
        where: { id: input.jobId },
        data: { worktreePath: input.worktreePath },
      });
      return { success: true };
    }),

  setBranch: t.procedure
    .input(SetBranchInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      await prisma.job.update({
        where: { id: input.jobId },
        data: { branch: input.branch },
      });
      return { success: true };
    }),
});

export type AppRouter = typeof appRouter;

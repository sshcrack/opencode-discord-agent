import { initTRPC } from "@trpc/server";
import {
  HeartbeatSchema,
  StatusUpdateSchema,
  PlanReadySchema,
  ApprovalSchema,
  SuggestionSchema,
  ClaimResponseSchema,
} from "./types";

export const t = initTRPC.create();

/**
 * The full tRPC router definition shared by bot (server) and worker (client).
 *
 * All procedures require `Authorization: Bearer <WORKER_SECRET>` via the
 * meta field – each side enforces auth in its own middleware.
 */
export const trpcRouter = t.router({
  heartbeat: t.procedure.input(HeartbeatSchema).mutation(async ({ input }) => {
    return { ok: true };
  }),

  pollNextJob: t.procedure
    .input(HeartbeatSchema)
    .output(ClaimResponseSchema)
    .query(async ({ input }) => {
      return { job: null };
    }),

  postStatus: t.procedure
    .input(StatusUpdateSchema)
    .mutation(async ({ input }) => {
      return { ok: true };
    }),

  planReady: t.procedure
    .input(PlanReadySchema)
    .mutation(async ({ input }) => {
      return { ok: true };
    }),

  approvePlan: t.procedure
    .input(ApprovalSchema)
    .mutation(async ({ input }) => {
      return { ok: true };
    }),

  suggestChange: t.procedure
    .input(SuggestionSchema)
    .mutation(async ({ input }) => {
      return { ok: true };
    }),
});

export type TrpcRouter = typeof trpcRouter;

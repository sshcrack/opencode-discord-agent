import { prisma } from "../db";

const LOCKED_STATUSES = new Set([
  "planning", "approved", "cancelled", "building", "done", "failed",
]);

const PLAN_READY = "plan_ready";

export async function handlePlanGet(jobId: number): Promise<Response> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return new Response(JSON.stringify({ error: "Unknown job" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const locked = job.status !== PLAN_READY;

  return new Response(
    JSON.stringify({
      planMd: job.planMd,
      status: job.status,
      locked,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

export async function handlePlanPut(
  jobId: number,
  token: string | null,
  body: { planMd?: string },
): Promise<Response> {
  if (!token) {
    return new Response(JSON.stringify({ error: "No edit token provided" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return new Response(JSON.stringify({ error: "Unknown job" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (job.planEditToken !== token) {
    return new Response(JSON.stringify({ error: "Invalid edit token" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (job.status !== PLAN_READY) {
    return new Response(JSON.stringify({ error: "Plan is locked" }), {
      status: 423,
      headers: { "Content-Type": "application/json" },
    });
  }

  const planMd = body.planMd;
  if (typeof planMd !== "string") {
    return new Response(JSON.stringify({ error: "Missing planMd field" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { planMd },
  });

  const thread = await prisma.reportThread.findUnique({
    where: { threadId: job.threadId },
  });
  if (thread) {
    try {
      const discord = await import("../discord/helpers").then((m) => m.getClient());
      const ch = await discord.channels.fetch(job.threadId);
      if (ch?.isThread()) {
        await ch.send("✏️ Plan was edited by user — submitter can now approve");
      }
    } catch {
      // Non-critical
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

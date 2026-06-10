import { prisma } from "../db";

const PLAN_READY = "plan_ready";

async function verifyToken(jobId: number, token: string | null) {
  if (!token) {
    return { error: new Response(JSON.stringify({ error: "No edit token provided" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    })};
  }
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return { error: new Response(JSON.stringify({ error: "Unknown job" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    })};
  }
  if (job.planEditToken !== token) {
    return { error: new Response(JSON.stringify({ error: "Invalid edit token" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    })};
  }
  return { job };
}

async function postToThread(threadId: string, message: string) {
  try {
    const discord = await import("../discord/helpers").then((m) => m.getClient());
    const ch = await discord.channels.fetch(threadId);
    if (ch?.isThread()) {
      await ch.send(message);
    }
  } catch {
    // Non-critical
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handlePlanGet(jobId: number): Promise<Response> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    return jsonResponse({ error: "Unknown job" }, 404);
  }

  const locked = job.status !== PLAN_READY;

  return jsonResponse({
    planMd: job.planMd,
    status: job.status,
    locked,
  });
}

export async function handlePlanPut(
  jobId: number,
  token: string | null,
  body: { planMd?: string },
): Promise<Response> {
  const { job, error } = await verifyToken(jobId, token);
  if (error) return error;

  if (job!.status !== PLAN_READY) {
    return jsonResponse({ error: "Plan is locked" }, 423);
  }

  const planMd = body.planMd;
  if (typeof planMd !== "string") {
    return jsonResponse({ error: "Missing planMd field" }, 400);
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { planMd },
  });

  await postToThread(job!.threadId, "✏️ Plan was edited by user — submitter can now approve");

  return jsonResponse({ success: true });
}

export async function handlePlanApprove(
  jobId: number,
  token: string | null,
): Promise<Response> {
  const { job, error } = await verifyToken(jobId, token);
  if (error) return error;

  if (job!.status !== PLAN_READY) {
    return jsonResponse({ error: "Plan is locked" }, 423);
  }

  await prisma.job.update({
    where: { id: jobId },
    data: { status: "approved" },
  });

  await postToThread(job!.threadId, "✅ Plan was approved via web viewer — proceeding to build");

  return jsonResponse({ success: true });
}

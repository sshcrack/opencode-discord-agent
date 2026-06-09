import { createTRPCClient, httpLink } from "@trpc/client";
import type { TrpcRouter } from "@discord-agent/shared";

const botUrl = process.env.BOT_URL || "http://localhost:3451";
const secret = process.env.WORKER_SECRET || "";

const headers: Record<string, string> = {
  "Content-Type": "application/json",
};
if (secret) headers["Authorization"] = `Bearer ${secret}`;

export const trpc = createTRPCClient<TrpcRouter>({
  links: [
    httpLink({
      url: `${botUrl}/trpc`,
      headers,
    }),
  ],
});

export async function postStatus(
  jobId: string,
  message: string,
  level: "info" | "success" | "error" = "info",
  extras?: { prUrl?: string; issueUrl?: string },
) {
  try {
    await trpc.postStatus.mutate({
      jobId,
      message,
      level,
      ...extras,
    });
  } catch (err) {
    console.error("postStatus failed:", err);
  }
}

export async function planReady(jobId: string, planMarkdown: string, sessionId: string) {
  try {
    await trpc.planReady.mutate({ jobId, planMarkdown, sessionId });
  } catch (err) {
    console.error("planReady failed:", err);
  }
}

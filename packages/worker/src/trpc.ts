import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "@opencode-discord/shared";
import { BOT_URL, SHARED_SECRET } from "./env";

const client = createTRPCClient<AppRouter>({
  links: [
    httpLink({
      url: `${BOT_URL}/trpc`,
      headers: { Authorization: `Bearer ${SHARED_SECRET}` },
    }),
  ],
});

async function postDebug(jobId: number, message: string) {
  await client.postStatus.mutate({ jobId, message, level: "debug" }).catch(() => {});
}

async function postInfo(jobId: number, message: string) {
  await client.postStatus.mutate({ jobId, message, level: "info" }).catch(() => {});
}

async function getIssueModel(): Promise<string> {
  try {
    const result = await client.getSetting.query({ key: "issue_model" });
    return result.value ?? "opencode/big-pickle";
  } catch {
    return "opencode/big-pickle";
  }
}

type PollNextJobOutput = Awaited<ReturnType<typeof client.pollNextJob.query>>;
type Job = PollNextJobOutput['jobs'][number];

export { client, postDebug, postInfo, getIssueModel };
export type { Job };

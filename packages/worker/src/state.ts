import { client } from "./trpc";

interface JobContext {
  jobId: number;
  threadId: string;
  typingInterval: Timer | null;
  startedAt: number;
}

const jobs = new Map<number, JobContext>();

function registerJob(jobId: number, threadId: string): void {
  const ctx: JobContext = { jobId, threadId, typingInterval: null, startedAt: Date.now() };
  ctx.typingInterval = setInterval(() => {
    client.typing.mutate({ jobId, threadId }).catch(() => {});
  }, 8_000);
  client.typing.mutate({ jobId, threadId }).catch(() => {});
  jobs.set(jobId, ctx);
}

function unregisterJob(jobId: number): void {
  const ctx = jobs.get(jobId);
  if (ctx?.typingInterval) clearInterval(ctx.typingInterval);
  jobs.delete(jobId);
}

function isEmpty(): boolean {
  return jobs.size === 0;
}

export { registerJob, unregisterJob, isEmpty };

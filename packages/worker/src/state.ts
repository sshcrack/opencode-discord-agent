import { client } from "./trpc";
import { WORKER_ID } from "./env";
import { workerLog } from "./logging";

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

async function releaseAllJobs(): Promise<number> {
  const ids = [...jobs.keys()];
  if (ids.length === 0) return 0;

  workerLog(`Releasing ${ids.length} active job(s) before shutdown...`);

  for (const id of ids) {
    unregisterJob(id);
  }

  try {
    const result = await client.releaseWorkerJobs.mutate({ workerId: WORKER_ID });
    workerLog(`Released ${result.released} job(s) via tRPC`);
    return result.released;
  } catch (err) {
    workerLog(`Failed to release jobs: ${err} (bot may be down — stale-job sweep will handle)`);
    return 0;
  }
}

export { registerJob, unregisterJob, isEmpty, releaseAllJobs };

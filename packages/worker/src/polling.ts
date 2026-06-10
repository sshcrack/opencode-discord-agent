import { WORKER_ID } from "./env";
import { client } from "./trpc";
import { workerLog } from "./logging";
import { getActiveJobId, setActiveJobId } from "./state";
import { handleJob } from "./handleJob";

async function poll(): Promise<void> {
  if (getActiveJobId() !== null) {
    workerLog(`Skipping poll — job #${getActiveJobId()} still active`);
    return;
  }
  const start = performance.now();
  const result = await client.pollNextJob.query({ workerId: WORKER_ID });
  if (result) {
    const elapsed = (performance.now() - start).toFixed(0);
    workerLog(`Claimed job #${result.id} for repo ${result.repoSlug} (poll took ${elapsed}ms)`);
    setActiveJobId(result.id);
    await handleJob(result);
  }
}

async function heartbeat() {
  try {
    const start = performance.now();
    await client.getJobStatus.query({ jobId: 0, workerId: WORKER_ID });
    workerLog(`Heartbeat OK (${(performance.now() - start).toFixed(0)}ms)`);
  } catch {
    // getJobStatus returns null for missing jobs — heartbeat still recorded
  }
}

export { poll, heartbeat };

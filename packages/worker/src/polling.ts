import { WORKER_ID, dryRun } from "./env";
import { client, type Job } from "./trpc";
import { workerLog } from "./logging";
import { registerJob, unregisterJob, isEmpty } from "./state";
import { handleJob } from "./handleJob";

async function poll(): Promise<void> {
  const localHead = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  const result = await client.pollNextJob.query({ workerId: WORKER_ID, gitHead: localHead });

  if (result.gitMismatch) {
    workerLog(`Outdated (local: ${localHead.slice(0, 12)}) — updating before claiming job...`);
    runUpdate();
    return;
  }

  for (const job of result.jobs ?? []) {
    workerLog(`Claimed job #${job.id} for repo ${job.repoSlug}`);
    registerJob(job.id, job.threadId);
    handleJob(job).finally(() => unregisterJob(job.id));
  }
}

function runUpdate() {
  workerLog(`Running update: git pull + bun install`);
  const pull = Bun.spawnSync(["git", "pull"]);
  if (pull.exitCode !== 0) {
    workerLog(`git pull failed: ${pull.stderr.toString().slice(0, 300)}`);
    return;
  }
  const install = Bun.spawnSync(["bun", "install"]);
  if (install.exitCode !== 0) {
    workerLog(`bun install failed: ${install.stderr.toString().slice(0, 300)}`);
  }
  workerLog(`Update complete — restarting...`);
  process.exit(0);
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

async function checkForUpdates() {
  if (!isEmpty()) return;
  if (dryRun) return;

  try {
    const botHead = await client.getBotHead.query();
    const localHead = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
    if (!localHead || !botHead.sha || botHead.sha === "unknown") return;
    if (localHead === botHead.sha) return;

    workerLog(`Update check: local=${localHead.slice(0, 12)} bot=${botHead.sha.slice(0, 12)} — updating...`);
    runUpdate();
  } catch (err) {
    workerLog(`Update check failed: ${err}`);
  }
}

export { poll, heartbeat, checkForUpdates };

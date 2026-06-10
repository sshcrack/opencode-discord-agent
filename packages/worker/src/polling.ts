import { WORKER_ID, dryRun } from "./env";
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

async function checkForUpdates() {
  if (getActiveJobId() !== null) return; // don't update mid-job
  if (dryRun) return;

  try {
    const botHead = await client.getBotHead.query();
    const localProc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
    const localHead = localProc.stdout.toString().trim();
    if (!localHead || !botHead.sha || botHead.sha === "unknown") return;

    if (localHead === botHead.sha) return;

    workerLog(`Git HEAD mismatch: local=${localHead.slice(0, 12)} bot=${botHead.sha.slice(0, 12)} — updating...`);

    const pull = Bun.spawnSync(["git", "pull"]);
    if (pull.exitCode !== 0) {
      workerLog(`git pull failed: ${pull.stderr.toString().slice(0, 300)}`);
      return;
    }

    workerLog(`git pull OK: ${pull.stdout.toString().slice(0, 200)}`);

    const install = Bun.spawnSync(["bun", "install"]);
    if (install.exitCode !== 0) {
      workerLog(`bun install failed: ${install.stderr.toString().slice(0, 300)}`);
    }

    workerLog(`Update complete — restarting worker...`);
    process.exit(0);
  } catch (err) {
    workerLog(`Update check failed: ${err}`);
  }
}

export { poll, heartbeat, checkForUpdates };

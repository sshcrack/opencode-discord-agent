import { BOT_URL, WORKER_ID, dryRun } from "./env";
import { workerLog } from "./logging";
import { poll, heartbeat, checkForUpdates } from "./polling";
import { killAllProcesses } from "./processes";

async function shutdown(signal: string) {
  console.log(`[${signal}] Worker shutting down gracefully...`);
  const killed = await killAllProcesses();
  if (killed > 0) console.log(`Force-killed ${killed} child process(es) after graceful shutdown`);
  const { releaseAllJobs } = await import("./state");
  await releaseAllJobs();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main() {
  console.log(`╔══════════════════════════════════════════════╗`);
  console.log(`║  Worker ${WORKER_ID.padEnd(10)}                 ║`);
  console.log(`║  Polling: ${BOT_URL}/trpc          ║`);
  console.log(`║  Interval: 5s (backoff: up to 60s)          ║`);
  console.log(`║  Heartbeat: 30s                              ║`);
  console.log(`║  Mode: ${dryRun ? "🧪 DRY RUN" : "🔧 LIVE".padEnd(23)}           ║`);
  console.log(`╚══════════════════════════════════════════════╝`);

  setInterval(() => {
    heartbeat().catch(err => workerLog("Heartbeat error:", err));
  }, 30_000);

  // Fallback: periodic update check ensures worker stays updated even when idle
  setInterval(() => {
    checkForUpdates().catch(err => workerLog("Update check error:", err));
  }, 60_000);

  let pollInterval = 5_000;
  const scheduleNextPoll = () => {
    setTimeout(() => {
      poll().then(success => {
        pollInterval = 5_000;
        scheduleNextPoll();
      }).catch(err => {
        workerLog(`Poll error (will retry in ${pollInterval / 1000}s):`, err);
        pollInterval = Math.min(pollInterval * 2, 60_000);
        scheduleNextPoll();
      });
    }, pollInterval);
  };
  scheduleNextPoll();
}

main().catch(console.error);

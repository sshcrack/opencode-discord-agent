import { trpc } from "./reporter";
import { handle } from "./handler";

const workerId = process.env.WORKER_ID || "unknown";

console.log(`Worker [${workerId}] starting…`);

// Heartbeat every 30s
setInterval(async () => {
  try {
    await trpc.heartbeat.mutate({ workerId });
  } catch (err) {
    console.error("Heartbeat failed:", err);
  }
}, 30_000);

// Poll loop every 5s
async function pollLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const response = await trpc.pollNextJob.query({ workerId });

      if (response.job) {
        console.log(`Claimed job ${response.job.id}`);
        await handle(response.job);
        console.log(`Finished job ${response.job.id}`);
      }
    } catch (err) {
      console.error("Poll failed:", err);
    }

    await sleep(5000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

pollLoop().catch((err) => {
  console.error("Fatal poll error:", err);
  process.exit(1);
});

import { WORKER_ID } from "./env";

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function workerLog(...args: unknown[]) {
  console.log(`[Worker ${WORKER_ID} ${timestamp()}]`, ...args);
}

function jobLog(jobId: number, ...args: unknown[]) {
  console.log(`[Worker ${WORKER_ID} ${timestamp()}] [Job #${jobId}]`, ...args);
}

export { workerLog, jobLog };

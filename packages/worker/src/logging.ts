import { WORKER_ID } from "./env";

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function workerLog(...args: any[]) {
  console.log(`[Worker ${WORKER_ID} ${timestamp()}]`, ...args);
}

function jobLog(jobId: number, ...args: any[]) {
  console.log(`[Worker ${WORKER_ID} ${timestamp()}] [Job #${jobId}]`, ...args);
}

export { workerLog, jobLog };

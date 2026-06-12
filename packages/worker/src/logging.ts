import { createConsola } from "consola";
import { WORKER_ID } from "./env";

const rootLogger = createConsola({
  formatOptions: { date: true, colors: false, compact: true },
}).withTag(`Worker ${WORKER_ID}`);

function workerLog(...args: unknown[]) {
  rootLogger.info(args.length === 1 ? args[0] : args);
}

function jobLog(jobId: number, ...args: unknown[]) {
  rootLogger.withTag(`Job #${jobId}`).info(args.length === 1 ? args[0] : args);
}

export { workerLog, jobLog };

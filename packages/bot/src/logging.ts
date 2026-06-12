import { createConsola } from "consola";

const rootLogger = createConsola({
  formatOptions: { date: true, colors: false, compact: true },
}).withTag("Bot");

function botLog(...args: unknown[]) {
  rootLogger.info(args.length === 1 ? args[0] : args);
}

function botWarn(...args: unknown[]) {
  rootLogger.warn(args.length === 1 ? args[0] : args);
}

function botError(...args: unknown[]) {
  rootLogger.error(args.length === 1 ? args[0] : args);
}

export { botLog, botWarn, botError };

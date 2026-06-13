import { skipPermissionsArg, isENOENT, formatENOENT, opencodeStallTimeoutMs } from "./env";
import { client } from "./trpc";
import { jobLog } from "./logging";
import { handleJsonEvent } from "./events";
import { trackProcess } from "./processes";

const ACCUMULATOR_FLUSH_INTERVAL = 3000;
const ACCUMULATOR_MAX_LINES = 15;

interface AccumulatorEntry {
  message: string;
  level: "info" | "debug" | "success";
  diff?: string;
}

class EventAccumulator {
  private entries: AccumulatorEntry[] = [];
  private _lastMode: "new" | "replace" | "append" = "new";
  private _level: "info" | "debug" | "success" = "info";

  get lastMode(): "new" | "replace" | "append" {
    return this._lastMode;
  }

  push(result: NonNullable<ReturnType<typeof handleJsonEvent>>): void {
    if (result.mode === "new") {
      this.flush();
    }
    this._lastMode = result.mode;
    if (result.level === "success") {
      this._level = result.level;
    } else if (this.entries.length === 0) {
      this._level = result.level;
    }
    this.entries.push({ message: result.message, level: result.level, diff: result.diff });
  }

  get level(): "info" | "debug" | "success" {
    return this._level;
  }

  get shouldFlush(): boolean {
    return this.entries.length >= ACCUMULATOR_MAX_LINES;
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  flush(): string | null {
    if (this.entries.length === 0) return null;
    const combined = this.entries.map(e => e.message).join("\n");
    this.entries = [];
    this._level = "info";
    return combined;
  }

  get currentDiff(): string | undefined {
    const lastEdit = this.entries.toReversed().find(e => e.diff);
    return lastEdit?.diff;
  }
}

async function runOpencodeStreaming(
  jobId: number,
  cwd: string,
  planFilePath: string | undefined,
  argv: string[],
  extraArgs: string[] = [],
  opts: { env?: Record<string, string>; stallTimeoutMs?: number } = {},
): Promise<{ planMd: string; sessionId: string }> {
  const fullArgs = [...argv, "--format", "json", ...skipPermissionsArg, ...extraArgs];
  jobLog(jobId, `Spawning: ${fullArgs.join(" ")}`);

  const proc = (() => {
    try {
      return trackProcess(Bun.spawn(fullArgs, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
      }));
    } catch (err: unknown) {
      if (isENOENT(err)) {
        throw new Error(formatENOENT("opencode"), { cause: err });
      }
      throw err;
    }
  })();

  let sessionId = "";
  let lineCount = 0;
  let buffer = "";
  const textParts: string[] = [];

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const streamStart = performance.now();
  const acc = new EventAccumulator();
  let lastFlush = performance.now();

  const stderrPromise = new Response(proc.stderr).text();

  // ── Stall watchdog ────────────────────────────────────────────────────
  // If the process produces no stdout activity for `stallTimeoutMs`, assume
  // it's stuck (e.g. SQLite lock contention between concurrent `opencode run`
  // processes, or a hung tool call) and kill it so the job fails cleanly
  // instead of hanging forever.
  const stallTimeoutMs = opts.stallTimeoutMs ?? opencodeStallTimeoutMs;
  let lastActivity = performance.now();
  let stalled = false;
  const watchdog = stallTimeoutMs > 0
    ? setInterval(() => {
        const idleMs = performance.now() - lastActivity;
        if (idleMs > stallTimeoutMs) {
          stalled = true;
          jobLog(jobId, `No opencode output for ${(idleMs / 1000).toFixed(0)}s — process appears stuck, killing it`);
          try {
            proc.kill(9);
          } catch {
            // already dead
          }
        }
      }, Math.min(15_000, Math.max(5_000, Math.floor(stallTimeoutMs / 4))))
    : null;

  async function flushAccumulator(forceNew: boolean = false): Promise<void> {
    if (acc.isEmpty) return;
    const combined = acc.flush();
    if (!combined) return;
    const mode = forceNew ? "new" : (acc.lastMode === "new" ? "replace" : "append");
    const diff = acc.currentDiff;
    await client.postStatus
      .mutate({ jobId, message: combined, level: acc.level, mode, diff })
      .catch(() => {});
    lastFlush = performance.now();
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastActivity = performance.now();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lineCount++;

        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

        const evt = event as Record<string, unknown>;

        if (!sessionId && evt.sessionID) {
          sessionId = String(evt.sessionID);
          jobLog(jobId, `Session: ${sessionId}`);
        }

        const result = handleJsonEvent(event, jobId, cwd);
        if (result) {
          const prevEmpty = acc.isEmpty;
          const isStepStart = result.mode === "new";
          if (isStepStart) {
            await flushAccumulator(true);
          }
          acc.push(result);
          if (acc.shouldFlush || (isStepStart && !prevEmpty)) {
            await flushAccumulator(isStepStart);
          }
        }

        if (evt.type === "text") {
          const evtPart = evt.part as Record<string, unknown> | undefined;
          if (evtPart && String(evtPart.text ?? "").trim()) {
            textParts.push(String(evtPart.text));
          }
        }
      }

      if (performance.now() - lastFlush > ACCUMULATOR_FLUSH_INTERVAL) {
        await flushAccumulator();
      }
    }
  } catch (err) {
    // If the watchdog killed the process, reader.read() may reject instead
    // of resolving with done:true — let the `stalled` check below produce
    // the clearer error message in that case.
    if (!stalled) throw err;
  } finally {
    reader.releaseLock();
    if (watchdog) clearInterval(watchdog);
  }

  await flushAccumulator(true);

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim());
      if (!sessionId && event.sessionID) {
        sessionId = event.sessionID;
        jobLog(jobId, `Session: ${sessionId}`);
      }
      const result = handleJsonEvent(event, jobId, cwd);
      if (result) {
        acc.push(result);
        await flushAccumulator(true);
      }
    } catch {
      // ignore partial/invalid JSON in tail buffer
    }
  }

  const elapsed = (performance.now() - streamStart).toFixed(0);
  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
  jobLog(jobId, `opencode finished: exit ${exitCode}, ${lineCount} events in ${elapsed}ms`);

  if (stalled) {
    throw new Error(
      `opencode process produced no output for ${(stallTimeoutMs / 1000).toFixed(0)}s and was killed. ` +
      `This usually means it got stuck — common causes are SQLite lock contention between concurrent ` +
      `'opencode run' processes sharing the same session database, or a hung tool call (e.g. reading a file). ` +
      `Set OPENCODE_STALL_TIMEOUT_MS to adjust the threshold or 0 to disable.`,
    );
  }

  if (exitCode !== 0) {
    jobLog(jobId, `opencode stderr: ${stderr.slice(0, 500)}`);
    throw new Error(`opencode failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  let planMd = "";
  if (planFilePath) {
    await Bun.sleep(500);
    const file = Bun.file(planFilePath);
    const exists = await file.exists();
    if (exists) {
      planMd = await file.text();
      jobLog(jobId, `Read plan from ${planFilePath} (${planMd.length} chars)`);
    } else {
      jobLog(jobId, `Plan file not found at ${planFilePath}`);
    }
  }
  if (!planMd && textParts.length > 0) {
    jobLog(jobId, `Plan file missing/empty, using ${textParts.length} text parts as fallback`);
    planMd = textParts.join("\n\n");
  }

  if (!sessionId) {
    jobLog(jobId, `No session ID detected`);
  }

  return { planMd: planMd || "", sessionId: sessionId || `fallback-${jobId}` };
}

export { runOpencodeStreaming };

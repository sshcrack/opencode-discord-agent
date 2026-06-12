import { skipPermissionsArg } from "./env";
import { client } from "./trpc";
import { jobLog } from "./logging";
import { handleJsonEvent } from "./events";
import { trackProcess } from "./processes";

async function runOpencodeStreaming(
  jobId: number,
  cwd: string,
  planFilePath: string | undefined,
  argv: string[],
  extraArgs: string[] = [],
): Promise<{ planMd: string; sessionId: string }> {
  const fullArgs = [...argv, "--format", "json", ...skipPermissionsArg, ...extraArgs];
  jobLog(jobId, `Spawning: ${fullArgs.join(" ")}`);

  const proc = trackProcess(Bun.spawn(fullArgs, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  }));

  let sessionId = "";
  let lineCount = 0;
  let buffer = "";
  const textParts: string[] = [];

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const streamStart = performance.now();

  const stderrPromise = new Response(proc.stderr).text();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
          await client.postStatus
            .mutate({ jobId, message: result.message, level: result.level, append: result.append })
            .catch(() => {});
        }

        if (evt.type === "text") {
          const evtPart = evt.part as Record<string, unknown> | undefined;
          if (evtPart && String(evtPart.text ?? "").trim()) {
            textParts.push(String(evtPart.text));
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer.trim());
      if (!sessionId && event.sessionID) {
        sessionId = event.sessionID;
        jobLog(jobId, `Session: ${sessionId}`);
      }
      const result = handleJsonEvent(event, jobId, cwd);
      if (result) {
        await client.postStatus
          .mutate({ jobId, message: result.message, level: result.level, append: result.append })
          .catch(() => {});
      }
    } catch {
      // ignore partial/invalid JSON in tail buffer
    }
  }

  const elapsed = (performance.now() - streamStart).toFixed(0);
  const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
  jobLog(jobId, `opencode finished: exit ${exitCode}, ${lineCount} events in ${elapsed}ms`);

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

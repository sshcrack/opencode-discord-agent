import { skipPermissionsArg } from "./env";
import { client } from "./trpc";
import { jobLog } from "./logging";
import { handleJsonEvent, extractPlanPath } from "./events";

async function runOpencodeStreaming(
  jobId: number,
  cwd: string,
  argv: string[],
  extraArgs: string[] = [],
): Promise<{ planMd: string; sessionId: string }> {
  const fullArgs = [...argv, "--format", "json", ...skipPermissionsArg, ...extraArgs];
  jobLog(jobId, `Spawning: ${fullArgs.join(" ")}`);

  const proc = Bun.spawn(fullArgs, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let sessionId = "";
  let planPath: string | null = null;
  const textParts: string[] = [];
  let lineCount = 0;
  let buffer = "";

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

        let event: any;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

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

        if (event.type === "text" && event.part?.text?.trim()) {
          const text = event.part.text.trim();
          textParts.push(text);
          if (!planPath) {
            const extracted = extractPlanPath(text);
            if (extracted) planPath = extracted;
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

  let planMd: string;
  if (planPath) {
    jobLog(jobId, `Reading plan from reported path: ${planPath}`);
    planMd = await Bun.file(planPath).text().catch(() => {
      jobLog(jobId, `Failed to read plan from ${planPath}, falling back to text`);
      return textParts.join("\n\n");
    });
  } else if (textParts.length > 0) {
    jobLog(jobId, `No plan path reported, using ${textParts.length} text parts`);
    planMd = textParts.join("\n\n");
  } else {
    jobLog(jobId, `No plan path or text content available`);
    planMd = "";
  }

  if (!sessionId) {
    jobLog(jobId, `No session ID detected`);
  }

  return { planMd: planMd || "", sessionId: sessionId || `fallback-${jobId}` };
}

export { runOpencodeStreaming };

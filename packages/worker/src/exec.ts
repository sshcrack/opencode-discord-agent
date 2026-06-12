import { jobLog } from "./logging";
import { trackProcess } from "./processes";
import { isENOENT, formatENOENT } from "./env";

async function execCommand(cmd: string, args: string[], cwd?: string, jobId?: number): Promise<string> {
  const jId = jobId ?? 0;
  jobLog(jId, `exec: ${cmd} ${args.join(" ")}${cwd ? ` (in ${cwd})` : ""}`);

  const proc = (() => {
    try {
      return trackProcess(Bun.spawn([cmd, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }));
    } catch (err: unknown) {
      if (isENOENT(err)) {
        throw new Error(formatENOENT(cmd), { cause: err });
      }
      throw err;
    }
  })();

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code === 0) {
    jobLog(jId, `${cmd} OK (${stdout.length} bytes stdout)`);
    return stdout;
  }

  jobLog(jId, `${cmd} FAILED (exit ${code}): ${stderr.slice(0, 200)}`);
  throw new Error(`${cmd} failed (exit ${code}): ${stderr}`);
}

export { execCommand };

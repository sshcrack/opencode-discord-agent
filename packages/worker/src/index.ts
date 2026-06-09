import { createTRPCClient, httpLink } from "@trpc/client";
import type { AppRouter } from "@opencode-discord/shared";
import { spawn } from "child_process";
import { readFile } from "fs/promises";

const {
  BOT_URL = "http://localhost:3000",
  SHARED_SECRET,
  WORKER_ID = "default",
  ISSUE_MODEL = "opencode/big-pickle",
} = process.env;

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

const client = createTRPCClient<AppRouter>({
  links: [
    httpLink({
      url: `${BOT_URL}/trpc`,
      headers: { Authorization: `Bearer ${SHARED_SECRET}` },
    }),
  ],
});

let currentJob: number | null = null;

async function poll() {
  try {
    const result = await client.pollNextJob.query({ workerId: WORKER_ID });

    if (result) {
      currentJob = result.id;
      console.log(`Claimed job #${result.id} for repo ${result.repoSlug}`);
      await handleJob(result);
    }
  } catch (err) {
    console.error("Poll error:", err);
  }
}

async function heartbeat() {
  try {
    await client.pollNextJob.query({ workerId: WORKER_ID });
  } catch (err) {
    console.error("Heartbeat error:", err);
  }
}

async function handleJob(job: NonNullable<Awaited<ReturnType<typeof client.pollNextJob.query>>>) {
  try {
    const repoPath = job.repoPath;
    if (!repoPath) {
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Repository path for \`${job.repoSlug}\` not found`,
        level: "error",
      });
      await client.cancelJob.mutate({ jobId: job.id });
      return;
    }

    await client.postStatus.mutate({
      jobId: job.id,
      message: `Creating worktree...`,
      level: "info",
    });

    const branch = `report-${job.id}-${Date.now().toString(36)}`;
    const { worktreePath } = await createWorktree(repoPath, branch);

    await client.postStatus.mutate({
      jobId: job.id,
      message: `Worktree created at \`${worktreePath}\` on branch \`${branch}\``,
      level: "info",
    });

    await client.postStatus.mutate({
      jobId: job.id,
      message: `Generating GitHub issue...`,
      level: "info",
    });

    const issueNumber = await generateIssue(job.id, repoPath, branch, job);

    if (issueNumber) {
      const repoName = repoPath.split("/").pop() || repoPath;
      const issueUrl = `https://github.com/${repoName}/issues/${issueNumber}`;
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Issue created: ${issueUrl}`,
        level: "success",
      });
    }

    await client.postStatus.mutate({
      jobId: job.id,
      message: `Starting planning agent...`,
      level: "info",
    });

    await prismaStatus(job.id, "planning");

    const { planMd, sessionId } = await runPlanAgent(job.id, worktreePath, job);

    await client.postStatus.mutate({
      jobId: job.id,
      message: `Planning complete, posting plan for review...`,
      level: "info",
    });

    await client.planReady.mutate({
      jobId: job.id,
      planMd,
      sessionId,
    });

    const approved = await waitForApproval(job.id, job.autoMode);
    if (!approved) {
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Job cancelled or not approved`,
        level: "error",
      });
      await cleanupWorktree(worktreePath);
      return;
    }

    await client.postStatus.mutate({
      jobId: job.id,
      message: `Starting build agent...`,
      level: "info",
    });

    await prismaStatus(job.id, "building");

    const prUrl = await runBuildAgent(job.id, worktreePath, issueNumber, branch);

    if (prUrl) {
      await client.postStatus.mutate({
        jobId: job.id,
        message: `PR created: ${prUrl}`,
        level: "success",
      });

      await client.postStatus.mutate({
        jobId: job.id,
        message: `Job complete!`,
        level: "success",
      });
    }

    cleanupWorktree(worktreePath).catch(() => {});
  } catch (err: any) {
    console.error("Job error:", err);
    await client.postStatus.mutate({
      jobId: job.id,
      message: `Job failed: ${err.message || err}`,
      level: "error",
    });
  } finally {
    currentJob = null;
  }
}

async function createWorktree(repoPath: string, branch: string): Promise<{ worktreePath: string }> {
  const addResult = await execCommand("gwq", ["add", "-b", branch], repoPath);
  console.log("gwq add output:", addResult);

  const getResult = await execCommand("gwq", ["get", branch], repoPath);
  const worktreePath = getResult.trim();
  console.log("gwq get output:", worktreePath);

  return { worktreePath };
}

async function generateIssue(
  jobId: number,
  repoPath: string,
  branch: string,
  job: any,
): Promise<number | null> {
  try {
    const contextMessages = `Job: ${job.kind} report for ${job.repoSlug}`;
    const prompt = `Create a GitHub issue for the repository at ${repoPath}. Context: ${contextMessages}\n\nOutput the issue title on the first line (as a markdown h1) and the body on subsequent lines.`;

    const proc = Bun.spawn(["opencode", "run", "--model", ISSUE_MODEL], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      await client.postStatus.mutate({
        jobId,
        message: `Issue generation failed (exit ${exitCode})`,
        level: "error",
      });
      return null;
    }

    const lines = output.trim().split("\n");
    const title = lines[0]?.replace(/^#\s*/, "").trim() || `[${job.repoSlug}] ${job.kind} report`;
    const body = lines.slice(1).join("\n").trim() || `Automated ${job.kind} report for ${job.repoSlug}`;

    const ghProc = Bun.spawn(
      ["gh", "issue", "create", "--title", title, "--body", body],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );

    const ghOutput = await new Response(ghProc.stdout).text();
    const ghExit = await ghProc.exited;

    if (ghExit === 0) {
      const match = ghOutput.trim().match(/\/(\d+)$/);
      if (match) return parseInt(match[1]);
    }

    return null;
  } catch (err) {
    console.error("Issue generation error:", err);
    return null;
  }
}

async function runPlanAgent(
  jobId: number,
  worktreePath: string,
  job: any,
): Promise<{ planMd: string; sessionId: string }> {
  const prompt = `You are planning a ${job.kind} implementation for the repository at ${worktreePath}. Review the codebase and create a plan in PLAN.md at the root of this worktree.`;

  const proc = Bun.spawn(["opencode", "run", "--agent", "plan"], {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "pipe",
  });

  let sessionId = "";
  let fullOutput = "";

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      fullOutput += chunk;

      const lines = chunk.split("\n").filter(l => l.trim());
      for (const line of lines) {
        if (line.includes("[agent]") || line.includes("[plan]") || line.match(/^\[?\d{2}:\d{2}:\d{2}\]?\s*(Creating|Analyzing|Planning|Reviewing)/)) {
          const clean = line.replace(/\[.*?\]\s*/g, "").trim();
          if (clean) {
            await client.postStatus.mutate({
              jobId,
              message: clean,
              level: "info",
            });
          }
        }

        const sessionMatch = line.match(/session[=:]\s*([a-zA-Z0-9_-]+)/i);
        if (sessionMatch) sessionId = sessionMatch[1];
      }
    }
  } finally {
    reader.releaseLock();
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Plan agent failed (exit ${exitCode}): ${stderr}`);
  }

  const planMd = await readFile(`${worktreePath}/PLAN.md`, "utf-8").catch(() => fullOutput);

  if (!sessionId) {
    const sidMatch = fullOutput.match(/session[=:]\s*([a-zA-Z0-9_-]+)/i);
    if (sidMatch) sessionId = sidMatch[1];
  }

  return { planMd, sessionId: sessionId || `session-${job.id}` };
}

async function waitForApproval(jobId: number, autoMode: boolean): Promise<boolean> {
  while (true) {
    await Bun.sleep(2000);

    try {
      const result = await client.pollNextJob.query({ workerId: WORKER_ID });

      if (result?.id === jobId) {
        if (result.status === "approved") return true;
        if (result.status === "cancelled") return false;
        if (result.status === "planning") {
          // Handle suggest changes - need to get the new plan
          await client.postStatus.mutate({
            jobId,
            message: `Revising plan based on feedback...`,
            level: "info",
          });

          // This is a simplified approach - in reality we'd need to resume the session
          await Bun.sleep(5000);
          return false;
        }
      }
    } catch {}
  }
}

async function runBuildAgent(
  jobId: number,
  worktreePath: string,
  issueNumber: number | null,
  branch: string,
): Promise<string | null> {
  const prompt = `Follow PLAN.md to implement the changes. When done, commit and push, then create a PR that closes #${issueNumber || "the issue"}.`;

  const proc = Bun.spawn(["opencode", "run", "--agent", "build"], {
    cwd: worktreePath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n").filter(l => l.trim());

      for (const line of lines) {
        if (line.includes("[agent]") || line.includes("[build]") || line.match(/^\[?\d{2}:\d{2}:\d{2}\]?\s*(Implementing|Building|Creating|Modifying|Testing|Committing)/)) {
          const clean = line.replace(/\[.*?\]\s*/g, "").trim();
          if (clean) {
            await client.postStatus.mutate({
              jobId,
              message: clean,
              level: "info",
            });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Build agent failed (exit ${exitCode}): ${stderr}`);
  }

  const prBody = issueNumber ? `Closes #${issueNumber}` : "";
  const prProc = Bun.spawn(
    ["gh", "pr", "create", "--title", `[${branch}] Implementation`, "--body", prBody],
    { cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
  );

  const prOutput = await new Response(prProc.stdout).text();
  const prExit = await prProc.exited;

  if (prExit !== 0) {
    const prErr = await new Response(prProc.stderr).text();
    await client.postStatus.mutate({
      jobId,
      message: `PR creation failed: ${prErr}`,
      level: "error",
    });
    return null;
  }

  return prOutput.trim();
}

async function cleanupWorktree(worktreePath: string) {
  try {
    await execCommand("gwq", ["remove", worktreePath]);
  } catch (err) {
    console.error("Worktree cleanup error:", err);
  }
}

async function prismaStatus(jobId: number, status: string) {
  try {
    await client.postStatus.mutate({
      jobId,
      message: `Status: ${status}`,
      level: "info",
    });
  } catch {}
}

function execCommand(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} failed (exit ${code}): ${stderr}`));
    });

    proc.on("error", (err) => reject(err));
  });
}

async function main() {
  console.log(`Worker ${WORKER_ID} starting, polling ${BOT_URL}/trpc`);

  setInterval(heartbeat, 30_000);
  setInterval(poll, 5_000);
}

main().catch(console.error);

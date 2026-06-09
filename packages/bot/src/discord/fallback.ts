import { prisma } from "../db";
import { postToThread } from "./helpers";

export async function runFallback(jobId: number, context: string, repoSlug: string, threadId: string) {
  const repo = await prisma.repository.findUnique({ where: { slug: repoSlug } });
  if (!repo) return;

  const setting = await prisma.setting.findUnique({ where: { key: "fallback_model" } });
  const model = setting?.value ?? "opencode/big-pickle";

  await postToThread(threadId, ":information_source: No worker online, running fallback path...");

  try {
    const prompt = `Analyse the following context and produce a structured GitHub issue (title + body) for the repository at ${repo.path}:\n\n${context}`;

    const proc = Bun.spawn(["opencode", "run", "--model", model], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      await postToThread(threadId, `:x: Fallback opencode failed (exit ${exitCode}): ${stderr}`);
      await prisma.job.update({ where: { id: jobId }, data: { status: "failed" } });
      return;
    }

    const lines = stdout.trim().split("\n");
    const title = lines[0]?.replace(/^#\s*/, "").trim() || `[${repoSlug}] Automated issue`;
    const body = lines.slice(1).join("\n").trim();

    await postToThread(threadId, ":information_source: Creating GitHub issue...");

    const ghProc = Bun.spawn(
      ["gh", "issue", "create", "--title", title, "--body", body, "--repo", repo.path],
      { stdout: "pipe", stderr: "pipe" },
    );

    const ghOutput = await new Response(ghProc.stdout).text();
    const ghExit = await ghProc.exited;

    if (ghExit !== 0) {
      const ghErr = await new Response(ghProc.stderr).text();
      await postToThread(threadId, `:x: Failed to create GitHub issue: ${ghErr}`);
      await prisma.job.update({ where: { id: jobId }, data: { status: "failed" } });
      return;
    }

    const issueUrl = ghOutput.trim();
    await postToThread(threadId, `:white_check_mark: Issue created: ${issueUrl}`);

    const commentProc = Bun.spawn(
      ["gh", "issue", "comment", issueUrl, "--body", "/opencode fix this issue in a PR"],
      { stdout: "pipe", stderr: "pipe" },
    );

    await commentProc.exited;
    await postToThread(threadId, `:white_check_mark: Triggered opencode on the issue. Job complete.`);

    await prisma.job.update({ where: { id: jobId }, data: { status: "done" } });
  } catch (err) {
    await postToThread(threadId, `:x: Fallback path error: ${err}`);
    await prisma.job.update({ where: { id: jobId }, data: { status: "failed" } });
  }
}

export async function checkWorkerOnline(): Promise<boolean> {
  const settings = await prisma.setting.findMany({
    where: { key: { startsWith: "worker:" } },
  });

  const now = Date.now();
  for (const s of settings) {
    if (s.key.endsWith(":lastSeen")) {
      const lastSeen = new Date(s.value).getTime();
      if (now - lastSeen < 60_000) return true;
    }
  }

  return false;
}

import { prisma } from "../db";
import { postToThread } from "./helpers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseNameWithOwner(originUrl: string): string | null {
  // git@github.com:owner/name.git  or  https://github.com/owner/name.git
  const match =
    originUrl.match(/github\.com[:\/](.+?)\.git$/) ||
    originUrl.match(/github\.com[:\/](.+?)(\/)?$/);
  return match?.[1] ?? null;
}

async function cloneRepo(repoSlug: string, originUrl: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `opencode-${repoSlug}-`));
  const cloneProc = Bun.spawn(
    ["git", "clone", originUrl, tmpDir, "--depth", "1"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [, stderr] = await Promise.all([
    new Response(cloneProc.stdout).text(),
    new Response(cloneProc.stderr).text(),
  ]);
  const cloneExit = await cloneProc.exited;
  if (cloneExit !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`Git clone failed: ${stderr.slice(0, 500)}`);
  }
  return tmpDir;
}

async function getRepoNameWithOwner(repoPath: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) return stdout.trim();
    return "";
  } catch {
    return "";
  }
}

export async function runFallback(
  jobId: number,
  context: string,
  repoSlug: string,
  threadId: string,
) {
  const repo = await prisma.repository.findUnique({ where: { slug: repoSlug } });
  if (!repo) return;

  await postToThread(threadId, "ℹ️ No worker online — running fallback path...");

  if (!repo.originUrl) {
    await postToThread(threadId, "❌ No origin URL configured for this repo — add one via `/repo add --origin-url`");
    return;
  }

  const nwo = parseNameWithOwner(repo.originUrl);
  if (!nwo) {
    await postToThread(threadId, `❌ Could not parse owner/name from origin URL: \`${repo.originUrl}\``);
    return;
  }

  let tmpDir: string | null = null;

  try {
    // Clone repo to temp directory
    await postToThread(threadId, "ℹ️ Cloning repository...");
    tmpDir = await cloneRepo(repoSlug, repo.originUrl);
    await postToThread(threadId, `ℹ️ Cloned to \`${tmpDir}\``);

    // Mark as claimed so workers don't pick it up during fallback
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "claimed", workerId: "fallback" },
    });

    const job = await prisma.job.findUnique({ where: { id: jobId } });

    let issueNumber = job?.issueNumber;
    let issueUrl: string;

    if (!issueNumber) {
      const setting = await prisma.setting.findUnique({ where: { key: "fallback_model" } });
      const model = setting?.value ?? "opencode/big-pickle";

      const prompt = [
        `Analyse the following Discord thread context and produce a structured GitHub issue.`,
        `Repository: ${repoSlug}`,
        ``,
        `Output ONLY:`,
        `Line 1: The issue title (plain text, no markdown heading)`,
        `Line 2+: The issue body in Markdown`,
        ``,
        `Context:`,
        context,
      ].join("\n");

      await postToThread(threadId, "ℹ️ Generating issue with opencode...");

      const proc = Bun.spawn(["opencode", "run", "--model", model, "--dir", tmpDir, prompt], {
        cwd: tmpDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        await postToThread(threadId, `❌ Fallback opencode failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
        await prisma.job.update({ where: { id: jobId }, data: { status: "failed" } });
        return;
      }

      const lines = stdout.trim().split("\n");
      const title = lines[0]?.replace(/^#+\s*/, "").trim() || `[${repoSlug}] Automated issue`;
      const body = lines.slice(1).join("\n").trim() || `Automated issue for ${repoSlug}`;

      await postToThread(threadId, "ℹ️ Creating GitHub issue...");

      const ghArgs = [
        "issue", "create",
        "--title", title,
        "--body", body,
        "--repo", nwo,
      ];

      const ghProc = Bun.spawn(["gh", ...ghArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [ghOutput, ghErr] = await Promise.all([
        new Response(ghProc.stdout).text(),
        new Response(ghProc.stderr).text(),
      ]);
      const ghExit = await ghProc.exited;

      if (ghExit !== 0) {
        await postToThread(threadId, `❌ Failed to create GitHub issue: ${ghErr.slice(0, 500)}`);
        await prisma.job.update({ where: { id: jobId }, data: { status: "failed" } });
        return;
      }

      issueUrl = ghOutput.trim();

      const match = issueUrl.match(/\/(\d+)$/);
      if (match && match[1]) {
        issueNumber = parseInt(match[1]);
        await prisma.job.update({ where: { id: jobId }, data: { issueNumber } });
      }

      await postToThread(threadId, `✅ Issue created: ${issueUrl}`);
    } else {
      issueUrl = `https://github.com/${nwo}/issues/${issueNumber}`;
    }

    await postToThread(threadId, "ℹ️ Triggering opencode on the issue...");

    const commentProc = Bun.spawn(
      ["gh", "issue", "comment", issueUrl, "--body", "/opencode fix this issue in a PR"],
      { stdout: "pipe", stderr: "pipe" },
    );
    await commentProc.exited;

    await postToThread(threadId, `✅ Triggered opencode on the issue. Job complete.\n${issueUrl}`);
    await prisma.job.update({ where: { id: jobId }, data: { status: "done" } });
  } catch (err) {
    await postToThread(threadId, `❌ Fallback path error: ${err}`);
    await prisma.job.update({ where: { id: jobId }, data: { status: "failed" } });
  } finally {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

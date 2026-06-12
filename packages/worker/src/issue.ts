import { dryRun, skipPermissionsArg } from "./env";
import { client, postInfo, getIssueModel } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { getRepoNameWithOwner } from "./worktree";
import { handleJsonEvent } from "./events";
import { trackProcess } from "./processes";

async function generateIssue(job: Job, repoPath: string): Promise<{ issueNumber: number | null; issueTitle: string }> {
  try {
    const issueModel = await getIssueModel();
    jobLog(job.id, `Issue model: ${issueModel}`);
    jobLog(job.id, `Context available: ${!!job.context}, context length: ${job.context?.length ?? 0} chars`);

    const prompt = [
      `Create a well-structured GitHub issue for the following ${job.kind} report.`,
      `Repository: ${job.repoSlug}`,
      ``,
      `# CRITICAL — Output format:`,
      `Wrap your issue in <issue> tags. Everything outside the tags is ignored.`,
      `<issue>`,
      `  <title>The issue title here</title>`,
      `  <description>`,
      `    The issue body in Markdown (can be multiple lines).`,
      `  </description>`,
      `</issue>`,
      ``,
      `## Report context:`,
      `Kind: ${job.kind}`,
      `Repo: ${job.repoSlug}`,
      ...(job.context ? [`\nDiscord thread context:\n${job.context}`] : []),
    ].join("\n");

    jobLog(job.id, `Issue prompt length: ${prompt.length} chars`);

    if (dryRun) {
      jobLog(job.id, `[DRY RUN] 🐛 Issue generation`);
      jobLog(job.id, `[DRY RUN] Model: ${issueModel}`);
      jobLog(job.id, `[DRY RUN] Would run: opencode run --model ${issueModel} --print ...`);
      jobLog(job.id, `[DRY RUN] Would run: gh issue create --title ... --body ...`);
      await postInfo(job.id, `[DRY RUN] Issue generation skipped — prompt logged to worker console`);
      return { issueNumber: null, issueTitle: "" };
    }

    const runStart = performance.now();
    jobLog(job.id, `Spawning: opencode run --model ${issueModel} --dir ${repoPath} --format json [${prompt.length} chars]`);

    const proc = trackProcess(Bun.spawn(
      ["opencode", "run", "--model", issueModel, "--dir", repoPath, prompt, "--format", "json", ...skipPermissionsArg],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    ));

    let issueText = "";
    let eventCount = 0;
    let buf = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const stderrPromise = new Response(proc.stderr).text();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          eventCount++;
          let event: unknown;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }
          const result = handleJsonEvent(event, job.id, repoPath);
          if (result) {
            await client.postStatus
              .mutate({ jobId: job.id, message: result.message, level: result.level, append: result.append })
              .catch(() => {});
          }
          const evt = event as Record<string, unknown>;
          if (evt.type === "text") {
            const evtPart = evt.part as Record<string, unknown> | undefined;
            if (evtPart?.text) {
              issueText += String(evtPart.text);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const exitCode = await proc.exited;
    const stderrContent = await stderrPromise;
    jobLog(job.id, `opencode issue gen finished: exit ${exitCode}, ${eventCount} events, output ${issueText.length} chars (${(performance.now() - runStart).toFixed(0)}ms)`);

    if (exitCode !== 0) {
      jobLog(job.id, `Issue generation stderr: ${stderrContent.slice(0, 300)}`);
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Issue generation failed (exit ${exitCode}): ${stderrContent.slice(0, 300)}`,
        level: "error",
      });
      return { issueNumber: null, issueTitle: "" };
    }

    const issueMatch = issueText.match(/<issue>([\s\S]*?)<\/issue>/i);
    let title: string;
    let body: string;
    if (issueMatch?.[1]) {
      const inner = issueMatch[1];
      const titleMatch = inner.match(/<title>([\s\S]*?)<\/title>/i);
      const bodyMatch = inner.match(/<description>([\s\S]*?)<\/description>/i);
      title = titleMatch?.[1]?.trim() || `[${job.repoSlug}] ${job.kind} report`;
      body = bodyMatch?.[1]?.trim() || `Automated ${job.kind} report for ${job.repoSlug}`;
    } else {
      const lines = issueText.trim().split("\n");
      title = lines[0]?.trim().replace(/^#+\s*/, "").trim() || `[${job.repoSlug}] ${job.kind} report`;
      body = lines.slice(1).join("\n").trim() || `Automated ${job.kind} report for ${job.repoSlug}`;
    }

    jobLog(job.id, `Issue title: ${title.slice(0, 80)}${title.length > 80 ? "..." : ""}`);
    jobLog(job.id, `Issue body length: ${body.length} chars`);

    const repoNameWithOwner = await getRepoNameWithOwner(repoPath);
    const ghArgs = [
      "issue", "create",
      "--title", title,
      "--body", body,
      ...(repoNameWithOwner ? ["--repo", repoNameWithOwner] : []),
    ];

    jobLog(job.id, `Spawning: gh ${ghArgs.join(" ")}`);
    const ghStart = performance.now();
    const ghProc = trackProcess(Bun.spawn(["gh", ...ghArgs], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }));

    const ghOutput = await new Response(ghProc.stdout).text();
    const ghExit = await ghProc.exited;
    jobLog(job.id, `gh issue create finished: exit ${ghExit}, output: ${ghOutput.trim()} (${(performance.now() - ghStart).toFixed(0)}ms)`);

    if (ghExit === 0) {
      const match = ghOutput.trim().match(/\/(\d+)$/);
      if (match && match[1]) {
        const num = parseInt(match[1]);
        jobLog(job.id, `Created issue #${num}: ${ghOutput.trim()}`);
        return { issueNumber: num, issueTitle: title };
      }
    }

    jobLog(job.id, `gh issue create returned non-zero exit ${ghExit}`);
    return { issueNumber: null, issueTitle: title };
  } catch (err) {
    jobLog(job.id, `Issue generation error:`, err);
    return { issueNumber: null, issueTitle: "" };
  }
}

export { generateIssue };

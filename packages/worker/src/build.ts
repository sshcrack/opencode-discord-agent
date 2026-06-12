import {
  dryRun,
  ghToken,
  gitBotName,
  gitBotEmail,
  gitCoauthorName,
  gitCoauthorEmail,
  hasCoauthor,
  isENOENT,
  formatENOENT,
} from "./env";
import { client, postInfo } from "./trpc";
import type { Job } from "./trpc";
import { jobLog } from "./logging";
import { runOpencodeStreaming } from "./opencode";

function setupGitAuthor(worktreePath: string, jobId: number) {
  Bun.spawnSync(["git", "config", "user.name", gitBotName], { cwd: worktreePath });
  Bun.spawnSync(["git", "config", "user.email", gitBotEmail], { cwd: worktreePath });

  process.env.GIT_AUTHOR_NAME = gitBotName;
  process.env.GIT_AUTHOR_EMAIL = gitBotEmail;
  process.env.GIT_COMMITTER_NAME = gitBotName;
  process.env.GIT_COMMITTER_EMAIL = gitBotEmail;

  if (ghToken) {
    process.env.GH_TOKEN = ghToken;
  }

  jobLog(jobId, `Git author configured: ${gitBotName} <${gitBotEmail}>`);
}

function getBaseBranch(worktreePath: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd: worktreePath });
  if (proc.exitCode === 0) {
    const ref = proc.stdout.toString().trim();
    return ref.replace(/^origin\//, "");
  }
  return "main";
}

async function amendCoauthor(worktreePath: string, jobId: number): Promise<void> {
  if (!hasCoauthor) return;

  const baseBranch = getBaseBranch(worktreePath);

  const logProc = Bun.spawnSync([
    "git", "log", `origin/${baseBranch}..HEAD`,
    "--reverse", "--format=%H",
  ], { cwd: worktreePath });

  if (logProc.exitCode !== 0) {
    jobLog(jobId, `Could not find base branch commits (origin/${baseBranch}..HEAD failed) — skipping co-author amendment`);
    return;
  }

  const commits = logProc.stdout.toString().trim().split("\n").filter(Boolean);
  if (commits.length === 0) {
    jobLog(jobId, `No new commits to amend with Co-authored-by trailer`);
    return;
  }

  jobLog(jobId, `Amending ${commits.length} commit(s) with Co-authored-by trailer...`);

  const trailer = `Co-authored-by: ${gitCoauthorName} <${gitCoauthorEmail}>`;
  const rebaseProc = Bun.spawnSync([
    "git", "rebase", `origin/${baseBranch}`,
    "--exec", `git commit --amend --no-edit --trailer "${trailer}"`,
  ], { cwd: worktreePath });

  if (rebaseProc.exitCode !== 0) {
    const errMsg = rebaseProc.stderr.toString().slice(0, 300);
    jobLog(jobId, `Rebase/amend failed: ${errMsg}`);
    Bun.spawnSync(["git", "rebase", "--abort"], { cwd: worktreePath });
    return;
  }

  const pushProc = Bun.spawnSync(["git", "push", "--force-with-lease"], { cwd: worktreePath });
  if (pushProc.exitCode !== 0) {
    const errMsg = pushProc.stderr.toString().slice(0, 300);
    jobLog(jobId, `Force push failed: ${errMsg}`);
  } else {
    jobLog(jobId, `Co-authored-by trailer applied and force-pushed`);
  }
}

async function runBuildAgent(
  job: Job,
  worktreePath: string,
  issueNumber: number | null,
  branch: string,
  helperPath: string,
  autoMode: boolean,
  quickMode: boolean,
  sessionToResume?: string | null,
): Promise<{ prUrl: string | null; sessionId: string | null }> {
  const issueRef = issueNumber
    ? `The related GitHub issue is #${issueNumber} — make sure the PR body contains "Closes #${issueNumber}".`
    : "";

  const askBlock = autoMode ? "" : `\n\nYou can ask questions and wait for answers using:
\`${helperPath} ask '...json...'\`

The \`ask\` command takes a JSON array argument. Each object has:
  - "q" (required): the question text
  - "options" (required): proposed answers the user can pick from
  - "recommended" (required): index of the recommended option

Examples:
  # One question:
  ${helperPath} ask '[{"q":"What approach?","options":["Refactor","Rewrite"],"recommended":0}]'

  # Multiple questions (answered one at a time in Discord):
  ${helperPath} ask '[{"q":"Color?","options":["Red","Blue"],"recommended":0},{"q":"Size?","options":["S","M","L"],"recommended":1}]'

The script blocks until all questions are answered. The output is:
  Q: Color?
  A: Red

  Q: Size?
  A: Large

Always provide options + a recommended answer.`;

  const helperBlock = `\n\nYou can post messages to the Discord thread and rename it by running:
  \`${helperPath} info "message"\` — info level
  \`${helperPath} success "message"\` — success message
  \`${helperPath} error "message"\` — error message
  \`${helperPath} --rename "new name"\` — rename thread`;

  let prompt: string;

  if (sessionToResume) {
    // Follow-up: continue existing session with new context
    prompt = [
      `Continue the previous work with this new context from the Discord thread:`,
      job.context ? `\n\nNew messages:\n${job.context}` : "",
      issueRef,
      `Continue working on the same branch. When done, commit all changes, push, and create a pull request (or update the existing one).`,
      helperBlock,
      askBlock,
    ].filter(Boolean).join(" ");
  } else if (quickMode) {
    const contextBlock = job.context
      ? `\n\nThe following is the Discord report thread context with file attachments:\n${job.context}`
      : "";
    prompt = [
      `You are building an implementation for repository ${job.repoSlug}.`,
      issueRef,
      contextBlock,
      `Review the context and issue above carefully, then implement the required changes.`,
      `When done, commit all changes with a clear message referencing the issue,`,
      `push the branch, then create a pull request. After creating it,`,
      `output the pull request URL.`,
      helperBlock,
      askBlock,
    ].filter(Boolean).join(" ");
  } else {
    prompt = [
      `Follow the plan in PLAN.md exactly to implement the required changes.`,
      issueRef,
      `When done, commit all changes with a clear message, push the branch, then create a pull request. After creating it, output the pull request URL.`,
      helperBlock,
      askBlock,
    ].filter(Boolean).join(" ");
  }

  jobLog(job.id, `Build prompt: ${prompt.length} chars, issueRef: ${!!issueNumber}, quickMode: ${quickMode}, resume: ${!!sessionToResume}`);

  if (dryRun) {
    jobLog(job.id, `[DRY RUN] 🔧 Build agent`);
    jobLog(job.id, `[DRY RUN] Prompt: ${prompt}`);
    jobLog(job.id, `[DRY RUN] Would run: opencode run --agent build --print ...`);
    await postInfo(job.id, `[DRY RUN] Build agent skipped — prompt logged to worker console`);
    return { prUrl: null, sessionId: null };
  }

  jobLog(job.id, `Starting opencode build agent in ${worktreePath}`);

  if (!sessionToResume) {
    setupGitAuthor(worktreePath, job.id);
  }

  const buildStart = performance.now();
  const buildArgs = ["opencode", "run", "--agent", "build", "--dir", worktreePath];
  if (sessionToResume) {
    buildArgs.push("--session", sessionToResume, "--continue");
  }
  buildArgs.push(prompt);

  const { sessionId } = await runOpencodeStreaming(job.id, worktreePath, undefined, buildArgs);
  jobLog(job.id, `Build agent finished in ${(performance.now() - buildStart).toFixed(0)}ms, session: ${sessionId}`);

  await amendCoauthor(worktreePath, job.id);

  const prView = (() => {
    try {
      return Bun.spawnSync(["gh", "pr", "view", "--json", "url", "--jq", ".url"], {
        cwd: worktreePath,
      });
    } catch (err: unknown) {
      if (isENOENT(err)) throw new Error(formatENOENT("gh"), { cause: err });
      throw err;
    }
  })();

  if (prView.exitCode !== 0) {
    // PR might not exist yet — try creating it
    const createView = (() => {
      try {
        return Bun.spawnSync(["gh", "pr", "create", "--fill", "--json", "url", "--jq", ".url"], {
          cwd: worktreePath,
        });
      } catch (err: unknown) {
        if (isENOENT(err)) throw new Error(formatENOENT("gh"), { cause: err });
        throw err;
      }
    })();
    if (createView.exitCode !== 0) {
      const createErr = (createView.stderr ?? "").toString().trim().slice(0, 400);
      jobLog(job.id, `Failed to get/create PR URL: ${createErr}`);
      await client.postStatus.mutate({
        jobId: job.id,
        message: `Failed to find/create PR: ${createErr}`,
        level: "error",
      });
      return { prUrl: null, sessionId: sessionId || null };
    }
    const prUrl = (createView.stdout ?? "").toString().trim();
    jobLog(job.id, `PR URL (created): ${prUrl}`);
    return { prUrl: prUrl || null, sessionId: sessionId || null };
  }

  const prUrl = (prView.stdout ?? "").toString().trim();
  jobLog(job.id, `PR URL: ${prUrl}`);
  return { prUrl: prUrl || null, sessionId: sessionId || null };
}

export { runBuildAgent };

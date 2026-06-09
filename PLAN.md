# Discord Agent — Specification

## What this is

A Bun monorepo with two packages (`bot`, `worker`) and a `shared` package for types and
the tRPC router definition. Users file bug reports, feature requests, or general tasks
via Discord slash commands. A worker script running on a dev laptop claims jobs, plans
them with an AI agent, waits for approval, then builds and opens a PR. When no worker is
online the bot falls back to the GitHub-hosted opencode agent.

---

## What I want

### General

- Bun workspaces monorepo with three packages: `shared`, `bot`, `worker`
- The Prisma database (SQLite adapter) lives **only** in the bot
- The worker never accesses the database directly — all state goes through tRPC
- The shared package contains only: zod schemas, inferred TypeScript types, and the tRPC
  router definition (no Prisma, no DB access)
- End-to-end type safety between bot and worker via tRPC v11 (fetch-native)
- All bot↔worker HTTP calls authenticated with a shared secret (`Authorization: Bearer`)
- Environment variables for secrets and URLs only; no configuration through env variables

---

### Repositories

- The bot maintains a registry of **root repositories**, each with a human-readable slug
  (e.g. `colonists`) that maps to an absolute path on the worker's filesystem
- Repositories are added, removed, and listed via Discord slash commands
- Removing a repository only removes the bot's record of it — it does not touch the
  filesystem and does not delete any worktrees
- One repository is designated the **default**; it is used when no repo is specified at
  report creation time
- The default is set either by a dedicated command or automatically when the first
  repository is added
- The default can be changed at any time via command
- There is no env variable for the default repository
- Repository records live in the bot's SQLite database

### What I do NOT want

- Cloning repositories — the worker assumes the directory already exists on disk
- Storing repository paths in env variables
- Any mechanism that touches the filesystem when a repo is removed

---

### Discord commands

#### `/repo add <slug> <path>`
Registers a new root repository. If it is the first repo added, it becomes the default
automatically. Fail if that path does not exist.

#### `/repo remove <slug>`
Removes the repository record. Does not affect the filesystem or any active worktrees.

#### `/repo list`
Lists all registered repositories, marking the default.

#### `/repo set-default <slug>`
Sets the named repository as the default.

---

#### `/create-report`
Options:
- `kind` (required) — select: `bug` / `feature` / `refactor` / `other`
- `repo` (optional) — slug of a registered repository; defaults to the current default, autocomplete enabled with registered repositories

Creates a private Discord thread. The thread name encodes the kind and a timestamp.
Stores the thread with its repo slug and kind in the database.

#### `/submit`
Options:
- `auto` (optional) — boolean; overrides the global auto-mode setting for this job

Can only be called inside an active report thread. Collects all thread messages and
attachment URLs, creates a job, and either dispatches it to the worker (if online) or
runs the fallback path immediately.

#### `/set-auto`
Options:
- `mode` (required) — select: `on` / `off`

Sets the global default for auto-mode. Stored in the database as a setting.

---

### Worker availability

- The worker long-polls the bot via `trpc.pollNextJob` every 5 seconds; this call also
  serves as a heartbeat
- A separate heartbeat ping runs every 30 seconds as a keep-alive
- A worker is considered online if its `lastSeen` timestamp is within 60 seconds
- Worker identity is set by a `WORKER_ID` env variable (e.g. `my-laptop`)

---

### Job lifecycle (worker path)

1. Worker claims a pending job via `pollNextJob`
2. Bot posts "worker picked up job" status to the thread
3. Worker runs `gwq add -b <branch>` inside the registered root repository path to
   create a new worktree
4. Worker runs `gwq get <branch>` to resolve the worktree's absolute path
5. Run a `opencode` instance using the `build` agent with model the issue generation model (configurable, defaults to `opencode/big-pickle`) with a prompt so it creates a issue with description and title on github of the repository, also make sure to note down the issue number, as its later used for the build agent when it opens up the PR, bot posts the issue URL to thread
6. Worker launches `opencode run --agent plan` inside that worktree path with a prompt
   derived from the job's kind and context, updates the discord thread with "planning started" status, and streams the opencode output back to the bot, you can run an opencode example instance while developing to see the expected output format, which should be properly formatted and reported back to the discord thread.
7. The plan agent writes `PLAN.md` to the worktree root and exits
8. Worker reads `PLAN.md` and the opencode session ID from the process output
9. Worker calls `trpc.planReady` with the plan markdown and session ID
10. Bot posts the plan to the Discord thread with three buttons: **Approve**, **Suggest
   changes**, **Cancel**

**If auto-mode is off:**
- User clicks a button
- **Approve** → proceed to build
- **Cancel** → worker tears down the worktree and marks the job cancelled
- **Suggest changes** → bot prompts the user to reply in the thread; that reply is
  forwarded to the worker; worker resumes the same opencode session with
  `--session <id> --continue` and the suggestion text; opencode rewrites `PLAN.md`;
  worker calls `trpc.planReady` again with the new plan; buttons reappear
- This loop continues until the user approves or cancels

**If auto-mode is on:**
- Plan is posted with only a Cancel button and a 10-second countdown message
- After 10 seconds (unless cancelled) the job proceeds to build automatically

**Build phase:**
10. Worker launches `opencode run --agent build` in the worktree with an instruction to
    follow `PLAN.md`
11. Worker streams meaningful progress lines back to the bot via `trpc.postStatus` (same as I described for the planning opencode run)
12. On success: worker runs `gh pr create` and reports the PR URL via `trpc.postStatus` (it should also link the issue number in the PR body to close the issue automatically)
13. Bot posts the PR URL to the thread and marks the job done
14. Worktree cleanup (`gwq remove`) is optional and non-blocking

---

### Fallback path (no worker online)

1. Bot runs `opencode run --model <previously talked issue model>` locally with a prompt instructing
   it to analyse the context and produce a structured GitHub issue (title + body)
2. Bot runs `gh issue create` with the output, using the repo's GitHub slug
3. Bot posts the issue URL to the thread
4. Bot runs `gh issue comment` with `/opencode fix this issue in a PR`
5. Bot posts confirmation and marks the job done and posts the issue URL to the thread
6. The fallback model is configurable via a setting stored in the database (default:
   `opencode/big-pickle`); there is no env variable for it

---

### Status reporting

- Every meaningful step (worktree created, plan agent started, plan ready, build started,
  PR opened, errors) is posted as a message to the originating Discord thread and especially the specific current build step etc (so analyze the opencode output and post the parsed output to the discord thread, I want to adjust "logging" levels, by default it should be verbose (so each step the agent makes in properly outputted) but also meaningful updates via a command I can call (a global setting))
- Status messages use emoji prefixes to indicate level: ℹ️ info, ✅ success, ❌ error
- The worker posts status by calling `trpc.postStatus`; the bot resolves the thread and
  posts the Discord message


---

### Database (bot only)

---

### What I do NOT want

- Any database access in the `shared` or `worker` packages
- Repository paths in environment variables
- The fallback model hardcoded anywhere other than the database seed/default
- The default repository in environment variables
- Any approval flow in the fallback path (the fallback is fire-and-forget)
- Blocking the poll loop while a job is running (the handler runs async; the loop
  awaits it, so only one job runs per worker at a time — this is intentional)

---

## Package responsibilities summary

| Package | Owns |
|---|---|
| `shared` | Zod schemas, TS types, tRPC router shape |
| `bot` | Prisma + SQLite, Discord client, tRPC standalone server, slash commands, button interactions, fallback logic |
| `worker` | tRPC client, poll loop, gwq + opencode + gh orchestration |

---

## Implementation order

1. `shared` — zod types and tRPC router definition
2. `bot` — Prisma schema and migrations
3. `bot` — tRPC server and queue procedures
4. `bot` — `/repo` command group
5. `bot` — `/create-report` and `/submit` commands
6. `bot` — `/set-auto` command
7. `bot` — button interaction handler and approval state machine
8. `bot` — fallback path
9. `worker` — tRPC client and reporter
10. `worker` — planner (gwq + opencode plan agent)
11. `worker` — builder (opencode build agent + gh pr create)
12. `worker` — handler orchestrator
13. `worker` — poll loop and heartbeat
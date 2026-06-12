# opencode-discord

A Discord bot that turns slash commands into AI-powered PRs. Users file bug reports, feature requests, or tasks via Discord, and a worker processes them with opencode (plan + build agents) to produce GitHub pull requests.

## Architecture

```
┌─────────────┐     tRPC (HTTP)     ┌──────────────┐
│   Discord   │◄──────────────────►│    Worker     │
│     Bot     │  pollNextJob        │  (dev laptop)│
│  (SQLite)   │  getJobStatus       │              │
│             │  postStatus         │  gwq + opencode
│  ┌───────┐  │  planReady          │  + gh CLI    │
│  │Prisma │  │  approveJob         │              │
│  └───────┘  │  cancelJob          └──────────────┘
│             │  suggestChanges
│             │  ackSuggestion
│             │  getSetting
└─────────────┘
```

Three packages in a Bun workspace:

| Package | Role |
|---------|------|
| `packages/shared` | Zod schemas, types, and tRPC router definition |
| `packages/bot` | Discord client, Prisma/SQLite, tRPC server |
| `packages/worker` | Polls bot, runs opencode/gwq/gh, reports status |

## Prerequisites

- **Bun** ≥ 1.2
- **Discord bot** with `applications.commands` scope and Gateway Intents: `Guilds`, `GuildMessages`, `MessageContent`
- **gwq** installed and on PATH (git worktree manager)
- **opencode** installed and on PATH
- **gh** (GitHub CLI) authenticated
- A repository directory with a checked-out git repo (the worker does **not** clone)

## Setup

```bash
# 1. Install dependencies
bun install

# 2. Set up the bot's environment (copy and fill in .env.example)
cp .env.example packages/bot/.env

# 3. Generate Prisma client and create the SQLite database
cd packages/bot
bunx prisma generate
bunx prisma db push
cd ../..
```

## Environment Variables

### Bot (`packages/bot/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | ✅ | — | Discord bot token |
| `SHARED_SECRET` | ✅ | — | Shared secret for tRPC auth |
| `DATABASE_URL` | ✅ | — | SQLite DB path e.g. `file:./dev.db` |
| `TRPC_PORT` | — | `3000` | tRPC HTTP server port |
| `ALLOWED_GUILD_ID` | — | — | Restrict to this guild only |
| `ALLOWED_USER_ID` | — | — | Restrict to this user only |

### Worker (`packages/worker/.env` or shell)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SHARED_SECRET` | ✅ | — | Must match bot's shared secret |
| `WORKER_ID` | — | `default` | Worker identity (e.g. `my-laptop`) |
| `BOT_URL` | — | `http://localhost:3000` | Bot's tRPC endpoint |

> **No model env variables** — the issue model and fallback model are stored in the database via settings, not env variables. Change them via `prisma studio` or a direct DB update.

## Running

### Bot

```bash
cd packages/bot
bun run dev
```

### Worker

```bash
SHARED_SECRET="your-secret" WORKER_ID="my-laptop" bun run --cwd packages/worker dev
```

## Discord Commands

| Command | Description |
|---------|-------------|
| `/repo add <slug> <path>` | Register a repository (first one becomes default automatically) |
| `/repo remove <slug>` | Remove a repository record (no filesystem change) |
| `/repo list` | List all registered repositories (default marked with ⭐) |
| `/repo set-default <slug>` | Change the default repository |
| `/create-report kind:<type> [repo:<slug>]` | Create a private report thread |
| `/submit [auto:true/false]` | Submit thread as a job (run inside a report thread) |
| `/set-auto mode:on/off` | Set global auto-mode (auto-approve plans after 10 s) |
| `/set-verbose mode:on/off` | Toggle verbose status reporting (default: on — all agent steps) |
| `/help` | Show a categorized list of all available commands |
| `/jobs [repo] [status] [limit]` | List recent jobs with optional filters |
| `/settings view` | View all current bot settings |
| `/settings model <name>` | Set the issue generation model |
| `/settings fallback-model <name>` | Set the fallback model (used when no worker online) |

## Job Flow

```
/create-report  →  private thread created
     │
     ▼  (users discuss in thread)
/submit  →  job created
     │
     ├── Worker online? ──No──► Fallback path (see below)
     │
     └──Yes──► Worker claims job
                   │
                   ├── gwq add -b <branch>  (create worktree)
                   ├── opencode run --model <issue_model>  (generate GitHub issue)
                   ├── opencode run --agent plan  (write PLAN.md)
                   ├── Post plan to thread with Approve / Suggest changes / Cancel buttons
                   │       │
                   │       ├── Approve → proceed to build
                   │       ├── Cancel  → worktree cleaned up, job cancelled
                   │       └── Suggest → user types feedback → opencode resumes session
                   │                      → new PLAN.md → buttons reappear (loop)
                   │
                   ├── opencode run --agent build  (implement PLAN.md)
                   └── gh pr create  →  PR URL posted to thread
```

### Fallback path (no worker online)

1. Bot runs `opencode run --model <fallback_model>` locally to generate an issue title + body
2. Bot runs `gh issue create` and posts the issue URL to the thread
3. Bot runs `gh issue comment` with `/opencode fix this issue in a PR`
4. Job marked done

## Database Settings

These settings are stored in the `Setting` table and can be changed via `prisma studio`:

| Key | Default | Description |
|-----|---------|-------------|
| `auto_mode` | `off` | Global auto-approve mode (`on`/`off`) |
| `verbose_mode` | `on` | Verbose status posting (`on`/`off`) |
| `issue_model` | `opencode/big-pickle` | Model used by worker to generate GitHub issues |
| `fallback_model` | `opencode/big-pickle` | Model used by bot fallback path |
| `worker:<id>:lastSeen` | — | Heartbeat timestamp (set automatically by worker) |

## Design Notes

- **No database access in worker** — all state flows through tRPC
- **Repo path resolved at claim time** — stored on the job record, never re-queried
- **Removal is record-only** — `/repo remove` never touches the filesystem
- **No env variables for models or repos** — everything is database-driven
- **Single job per worker** — the poll loop is intentionally single-tenant
- **Auto-mode** — plans auto-approve after a 10-second cancellable countdown
- **Verbose mode** — defaults to on; set to off to suppress info-level status messages
- **Suggest-changes loop** — worker polls `getJobStatus` for `pendingSuggestion`, resumes the opencode session with `--session --continue`, re-posts the updated plan

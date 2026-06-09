# opencode-discord

A Discord bot that turns slash commands into AI-powered PRs. Users file bug reports, feature requests, or tasks via Discord, and a worker processes them with opencode (plan + build agents) to produce GitHub pull requests.

## Architecture

```
┌─────────────┐     tRPC (HTTP)     ┌──────────────┐
│   Discord   │◄──────────────────►│    Worker     │
│     Bot     │  pollNextJob        │  (your dev   │
│  (SQLite)   │  postStatus         │   laptop)    │
│             │  planReady          │              │
│  ┌───────┐  │  approveJob         │  gwq + opencode
│  │Prisma │  │  cancelJob          │  + gh CLI    │
│  └───────┘  │  suggestChanges     │              │
└─────────────┘                     └──────────────┘
```

Three packages in a Bun workspace:

| Package | Role |
|---------|------|
| `packages/shared` | Zod schemas, types, and tRPC router definition |
| `packages/bot` | Discord client, Prisma/SQLite, tRPC server |
| `packages/worker` | Polls bot, runs opencode/gwq/gh, reports status |

## Prerequisites

- **Bun** >=1.2
- **Discord bot** with `applications.commands` scope and Gateway Intents: `Guilds`, `GuildMessages`, `MessageContent`
- **gwq** installed and on PATH
- **opencode** installed and on PATH
- **gh** (GitHub CLI) authenticated
- A repository directory with a checked-out git repo (the worker does NOT clone)

## Setup

```bash
# Install dependencies
bun install

# Build shared package (required before bot/worker)
bun run --cwd packages/shared build

# Generate Prisma client and create SQLite database
cd packages/bot
bunx prisma generate
bunx prisma db push
cd ../..
```

## Environment Variables

### Bot (`packages/bot`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `SHARED_SECRET` | Yes | — | Shared secret for tRPC auth |
| `TRPC_PORT` | No | `3000` | tRPC HTTP server port |
| `DATABASE_URL` | Yes | — | SQLite database URL (e.g. `file:./dev.db`) |
| `ALLOWED_GUILD_ID` | No | — | Restrict commands to this guild only (omit for all guilds) |
| `ALLOWED_USER_ID` | No | — | Restrict commands to this user only (omit for all users) |

### Worker (`packages/worker`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SHARED_SECRET` | Yes | — | Must match bot's shared secret |
| `WORKER_ID` | No | `default` | Worker identity (e.g. `my-laptop`) |
| `BOT_URL` | No | `http://localhost:3000` | Bot's tRPC endpoint |
| `ISSUE_MODEL` | No | `opencode/big-pickle` | Model for issue generation |

## Running

### Bot

```bash
DATABASE_URL="file:./dev.db" \
DISCORD_TOKEN="your-token" \
SHARED_SECRET="your-secret" \
bun run --cwd packages/bot dev
```

### Worker

```bash
SHARED_SECRET="your-secret" \
WORKER_ID="my-laptop" \
bun run --cwd packages/worker dev
```

## Discord Commands

| Command | Description |
|---------|-------------|
| `/repo add <slug> <path>` | Register a repository (first one becomes default) |
| `/repo remove <slug>` | Remove a repository record (no filesystem change) |
| `/repo list` | List all registered repositories |
| `/repo set-default <slug>` | Change the default repository |
| `/create-report kind:<type> [repo:<slug>]` | Create a private report thread |
| `/submit [auto:true/false]` | Submit thread as a job (inside report thread) |
| `/set-auto mode:on/off` | Set global auto-mode (auto-approve plans) |

## Job Flow

1. User calls `/create-report` → private Discord thread created
2. Users discuss the issue in the thread
3. User calls `/submit` → job created
4. **If worker online**: Worker claims job, creates worktree, generates GitHub issue, runs opencode plan agent, posts plan for approval, runs build agent, opens PR
5. **If worker offline**: Bot runs fallback — generates GitHub issue via opencode, comments `/opencode fix this`

## Design Decisions

- **No database access in worker** — all state goes through tRPC
- **Repository slugs, not paths** — worker never stores filesystem paths; path resolution happens in the bot
- **Removal is record-only** — `/repo remove` never touches the filesystem
- **No env variables for repositories or models** — everything is database-driven
- **Single job per worker** — the poll loop is intentionally synchronous
- **Auto-mode** — when on, plans auto-approve after a 10-second countdown

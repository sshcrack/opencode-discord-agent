# Discord Agent

A Bun monorepo that lets you file bug reports and feature requests via Discord and have them automatically planned, approved, and implemented by an AI agent — either running locally on your dev machine or falling back to the GitHub opencode agent when offline.

## How it works

1. Admin registers a local directory with `/add-repository name:my-project path:/home/user/project`
2. Anyone runs `/create-report kind:bug repo:my-project` — a private thread is created
3. User adds context (messages, files) then runs `/submit`
4. If a worker is online: it picks up the job, runs `opencode plan` directly in that directory, posts the plan to the thread for approval (Approve / Suggest / Cancel buttons), then runs `opencode build` and optionally creates a PR if it's a git repo
5. If no worker is online: falls back to `FALLBACK_MODEL` → GitHub issue → `/opencode fix`

No git cloning, no worktree management — the worker works on whatever local path you register.

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- [opencode](https://opencode.ai) CLI installed and authenticated
- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated (only needed for fallback or PR creation)
- A Discord application with bot token (see below)

## Setup

### 1. Discord bot

Create a Discord application at https://discord.com/developers/applications:

- Go to **Bot** → **Reset Token** and copy the token
- Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
- Go to **OAuth2** → **URL Generator**:
  - Scopes: `bot`, `applications.commands`
  - Bot permissions: `Send Messages`, `Manage Threads`, `Read Message History`, `Add Reactions`, `Use Slash Commands`
- Use the generated URL to invite the bot to your server
- Copy the **Application ID** from **General Information**
- Optionally copy the server ID (right-click server → Copy ID) for dev-only command registration

### 2. GitHub authentication

```bash
gh auth login
```

### 3. Environment

```bash
cp .env.example .env
```

Fill in at minimum `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `WORKER_SECRET` — see [Environment variables](#environment-variables) below for the full list.

### 4. Install & migrate

```bash
bun install
cd packages/shared
DATABASE_URL="file:../bot/data/agent.db" bunx prisma migrate dev --name init
cd ../..
```

## Running

Start the bot (Discord client + tRPC HTTP server):

```bash
bun run dev:bot
```

In a separate terminal, start the worker (polls for jobs, runs opencode agents):

```bash
bun run dev:worker
```

### First-time setup in Discord

```
/add-repository name:my-project path:/absolute/path/to/code
```

Then anyone can create reports pointing at that project.

## Slash commands

| Command | Description |
|---|---|
| `/add-repository name:my-app path:/home/user/app` | Register a local directory for the agent to work on |
| `/list-repositories` | List all registered directories |
| `/remove-repository name:my-app` | Remove a registered directory |
| `/create-report kind:bug repo:my-app` | Creates a private thread for a report |
| `/submit auto:true` | Submits thread context for processing |
| `/set-auto mode:on` | Sets global auto-approve mode |

### Typical flow

1. Admin: `/add-repository name:my-app path:/home/user/my-app`
2. User: `/create-report kind=bug` — creates `[bug] 1712345678901` thread
3. User posts messages describing the issue, uploads screenshots/files
4. User: `/submit` — bot gathers all messages, creates a job
5. If worker is online: plan is posted as a markdown block with **Approve** / **Suggest changes** / **Cancel** buttons
6. Click **Approve** → worker runs `opencode build` directly in `/home/user/my-app`
7. If it's a git repo with a remote, a PR is created automatically
8. If no worker is online: fallback creates a GitHub issue and triggers `/opencode fix`

### Auto mode

Set a global default:

```
/set-auto mode:on
```

Or override per-job:

```
/submit auto:true
```

When auto mode is on, plans are auto-approved after a 10-second countdown (with a Cancel button to abort).

## Architecture

```
Discord ──bot────tRPC────worker──→ opencode plan/build
  user    (Bun.serve)   (poll)     in registered directory
                                          ↓
                              optional PR if git repo
```

- **bot**: Discord.js client, slash command handlers, tRPC server runtime. Owns all state via SQLite/Prisma.
- **worker**: Stateless poll loop. Claims pending jobs, looks up the registered directory path, runs `opencode plan` and `opencode build` directly in that directory.
- **shared**: Prisma schema, Zod types, tRPC router definition — consumed by both bot and worker.

The bot is the single source of truth. The worker communicates exclusively through tRPC and never touches the database directly.

## Fallback (no worker)

When no worker is online at submit time:
1. `opencode run --model <FALLBACK_MODEL>` generates a structured GitHub issue
2. `gh issue create` posts it to `FALLBACK_REPO`
3. `gh issue comment` triggers the opencode GitHub agent with `/opencode fix`
4. The opencode agent handles the fix as a PR on GitHub

The worker path (when online) does **not** use the fallback model — it runs with your default opencode model.

## Packages

| Package | Role | Key deps |
|---|---|---|
| `@discord-agent/shared` | Prisma schema, Zod types, tRPC router shape | `@trpc/server`, `zod`, `@prisma/client` |
| `@discord-agent/bot` | Discord client, slash commands, tRPC server | `discord.js`, `@trpc/server` |
| `@discord-agent/worker` | Job poller, opencode agent runner, PR creator | `@trpc/client` |

## Environment variables

All variables go in a root `.env` file. Bun picks it up automatically.

| Variable | Used by | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | bot | — | Bot token from the Discord developer portal (Bot → Reset Token) |
| `DISCORD_CLIENT_ID` | bot | — | Application ID from Discord developer portal (General Information) |
| `DISCORD_GUILD_ID` | bot | — | Server ID for dev-only slash command registration. Omit for global commands (takes up to 1h to propagate) |
| `BOT_PORT` | bot | `3451` | Port for the bot's tRPC HTTP server that the worker connects to |
| `WORKER_SECRET` | both | — | Shared secret for tRPC auth. Generate with `openssl rand -hex 16`. Must match between bot and worker |
| `DATABASE_URL` | bot | `file:./data/agent.db` | SQLite database path. Relative to the bot package working directory |
| `FALLBACK_REPO` | bot | — | GitHub repo slug (e.g. `owner/repo`) for the fallback path when no worker is online |
| `FALLBACK_MODEL` | bot | `opencode/big-pickle` | opencode model used for fallback issue generation |
| `BOT_URL` | worker | `http://localhost:3451` | Address of the bot's tRPC server. Set to the machine's LAN/VPN IP if worker runs on a different machine |
| `WORKER_ID` | worker | `my-laptop` | Unique identifier for this worker instance. Visible in heartbeat logs and job claims |

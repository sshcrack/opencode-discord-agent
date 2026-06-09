# Discord Agent

A Bun monorepo that lets you file bug reports and feature requests via Discord and have them automatically planned, approved, and fixed by an AI agent — either running locally on your dev laptop or falling back to the GitHub opencode agent when offline.

## Structure

```
discord-agent/
├── packages/
│   ├── shared/       # Prisma schema, Zod types, tRPC router shape
│   ├── bot/          # Discord.js client, slash commands, tRPC server
│   └── worker/       # Poll loop, planner, builder, PR creation
```

## Quick start

```bash
cp .env.example .env   # fill in tokens
bun install
bun run dev:bot        # start Discord bot + tRPC server
bun run dev:worker     # start worker (separate terminal)
```

## Slash commands

| Command | Description |
|---|---|
| `/create-report kind:bug repo:owner/repo` | Creates a private thread for a report |
| `/submit auto:true` | Submits thread context for processing |
| `/set-auto mode:on` | Sets global auto-approve mode |

## How it works

1. User runs `/create-report` → a private thread is created
2. User adds context (messages, files) then runs `/submit`
3. If a worker is online: it picks up the job, runs `opencode plan`, posts the plan to the thread for approval (Approve / Suggest / Cancel buttons), then runs `opencode build` and creates a PR
4. If no worker is online: falls back to `opencode big-pickle` → GitHub issue → `/opencode fix`

## Environment

All config via `.env` — see `.env.example` for the full list.

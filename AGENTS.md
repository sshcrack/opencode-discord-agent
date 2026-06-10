<!-- intent-skills:start -->
## Skill Loading

Before substantial work (and after installing trpc):
- Skill check: run `npx @tanstack/intent@latest list`, or use skills already listed in context.
- Skill guidance: if one local skill clearly matches the task, run `npx @tanstack/intent@latest load <package>#<skill>` and follow the returned `SKILL.md`.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.
<!-- intent-skills:end -->


## Repo structure

Three-package Bun workspace — no frontend, no tests:

| Package | Entrypoint | Role |
|---------|------------|------|
| `packages/shared` | `src/index.ts` | Zod schemas, types, tRPC router *definition* (stubs only) |
| `packages/bot` | `src/index.ts` | Discord client, Prisma/SQLite, tRPC server (handles real router impl) |
| `packages/worker` | `src/index.ts` | Polls bot via tRPC, runs `gwq`/`opencode`/`gh`, reports status |

## Database (bot only)

- **Prisma schema**: `packages/bot/prisma/schema.prisma`
- **Generated client output**: `packages/bot/src/db/generated/` (set in schema via `output = "../src/db/generated"`)
- Uses `prisma-client` (v7+ JS API, **not** `prisma-client-js`), `engineType = "client"`, `runtime = "bun"`
- Worker has **zero** database access — all state through tRPC
- Schema uses **SQLite** via `@prisma/adapter-libsql`

## Environment setup

```bash
bun install
cp .env.example packages/bot/.env
bun run db:generate    # bunx --bun prisma generate —cwd packages/bot
bun run db:migrate     # bunx --bun prisma migrate dev —cwd packages/bot
```

`packages/bot/.env` needs `DISCORD_TOKEN`, `CLIENT_ID`, `SHARED_SECRET`, `DATABASE_URL`. Worker reads env from shell or its own `.env`.

## Schema changes (must use migrations)

Always use `prisma migrate dev --name <name>` for schema changes, never `prisma db push` (it skips migration tracking).

```bash
bun run --cwd packages/bot prisma migrate dev --name describe_change
bunx --bun prisma generate --schema=packages/bot/prisma/schema.prisma
```

Run all prisma commands from `packages/bot/` where `prisma.config.ts` loads `DATABASE_URL` from `.env`.

## Running

```bash
bun run dev:bot        # bun run --cwd packages/bot dev (watch mode)
bun run dev:worker     # bun run --cwd packages/worker dev (watch mode)
```

Worker also requires `SHARED_SECRET` and optionally `WORKER_ID`, `BOT_URL`, `DRY_RUN`.

## Deploying slash commands

```bash
bun run bot-deploy     # bun run --cwd packages/bot deploy
```

Requires `CLIENT_ID` env var in addition to `DISCORD_TOKEN`. Deletes guild commands first, then registers globally.

## Typechecking

```bash
bun run typecheck      # bunx tsc --noEmit -p packages/bot && bunx tsc --noEmit -p packages/worker && bunx tsc --noEmit -p packages/shared
```

No lint or format scripts exist.

## Testing

No tests exist in this repo — `bun test` finds nothing.

## Framework quirks

- **tRPC router stubs** live in `packages/shared/src/router.ts` but throw "Not implemented" — the real implementation is in `packages/bot/src/trpc/router.ts` using Prisma. Shared package is for type safety between bot and worker only.
- **Auth**: All tRPC calls authenticated via `Authorization: Bearer <SHARED_SECRET>`. Bot's tRPC server (`packages/bot/src/trpc/server.ts`) verifies on every request.
- **Prisma v7+**: `prisma-client` generator with engineType `"client"` (no binary engine). Run all prisma commands with `bunx --bun prisma` from `packages/bot/` (the `prisma.config.ts` picks up env vars there).
- **Worker doesn't clone repos** — assumes the registered path exists on disk. Uses `gwq` (git worktree manager) to create branches. Requires `gwq`, `opencode`, and `gh` CLI on PATH.
- **env vars only for secrets/URLs** — models, auto-mode, verbose-mode are all stored in the `Setting` database table, not env.
- **No `.github/` CI** — infrastructure-less design, runs on dev laptop.
- **tRPC v11 HTTP body format**: The `fetchRequestHandler` has two distinct modes. For *single* calls (no `?batch=1` in URL), the POST body is `JSON.stringify(input)` directly — no wrapping. For *batch* calls (`?batch=1`), the body is `JSON.stringify({"0": input0, "1": input1, ...})`. The worker's bash helper curl calls must NOT use the `{"0": ...}` batch format unless the URL includes `?batch=1`.

## Key conventions

- All bot↔worker communication via tRPC (HTTP, bearer token). Worker logs structured `[Worker <id> <timestamp>]` prefix, job logs with `[Job #<id>]`.
- Status messages use emoji prefixes: ℹ️ info, ✅ success, ❌ error. Verbose mode (default on) controls whether info-level messages post to Discord.
- Worker is single-tenant — only one job at a time per worker instance.
- `DRY_RUN=true` env var skips `gwq`/`opencode`/`gh` execution but logs everything.
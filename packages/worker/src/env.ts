const {
  BOT_URL = "http://localhost:3000",
  SHARED_SECRET,
  WORKER_ID = "default",
  DRY_RUN,
  SKIP_PERMISSIONS = "true",
  GH_TOKEN,
  GIT_BOT_NAME = "opencode-bot",
  GIT_BOT_EMAIL = "opencode-bot@users.noreply.github.com",
  GIT_COAUTHOR_NAME,
  GIT_COAUTHOR_EMAIL,
  OPENCODE_STALL_TIMEOUT_MS,
  PATH: ENV_PATH = process.env.PATH ?? "",
} = process.env;

const dryRun = DRY_RUN === "true";
const skipPermissions = SKIP_PERMISSIONS === "true";
const skipPermissionsArg = skipPermissions ? ["--dangerously-skip-permissions"] : [];
const ghToken = GH_TOKEN || "";
const gitBotName = GIT_BOT_NAME;
const gitBotEmail = GIT_BOT_EMAIL;
const gitCoauthorName = GIT_COAUTHOR_NAME || "";
const gitCoauthorEmail = GIT_COAUTHOR_EMAIL || "";
const hasCoauthor = !!(gitCoauthorName && gitCoauthorEmail);

// How long an `opencode` subprocess may go without producing any stdout
// events before the worker considers it stuck and kills it. This converts
// a silent infinite hang (e.g. SQLite lock contention between parallel
// `opencode run` processes sharing the same session DB, or a stuck
// subagent/tool call) into a clean failure that can be retried, instead of
// blocking the job — and the worker — forever.
// Set to 0 to disable.
const DEFAULT_OPENCODE_STALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const opencodeStallTimeoutMs = OPENCODE_STALL_TIMEOUT_MS !== undefined
  ? Number.parseInt(OPENCODE_STALL_TIMEOUT_MS, 10) || 0
  : DEFAULT_OPENCODE_STALL_TIMEOUT_MS;

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

// ── PATH augmentation ──────────────────────────────────────────────────────
const COMMON_PATHS = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/local/sbin",
  "/usr/sbin",
  "/sbin",
  ...(process.env.HOME ? [`${process.env.HOME}/.local/bin`, `${process.env.HOME}/.bun/bin`] : []),
];

const existing = ENV_PATH.split(":").filter(Boolean);
const missing: string[] = [];
for (const p of COMMON_PATHS) {
  if (!existing.includes(p)) missing.push(p);
}

const AUGMENTED_PATH = [...existing, ...missing].join(":");

// Apply augmented PATH so all Bun.spawn calls inherit it
process.env.PATH = AUGMENTED_PATH;

const REQUIRED_BINARIES = ["git", "gwq", "gh", "opencode", "bun"];

function requireBinaries(): void {
  const missingBins: string[] = [];
  for (const bin of REQUIRED_BINARIES) {
    const which = Bun.spawnSync(["which", bin], { env: { PATH: AUGMENTED_PATH } });
    if (which.exitCode !== 0) {
      missingBins.push(bin);
    }
  }
  if (missingBins.length > 0) {
    throw new Error(
      `Required binaries not found on PATH: ${missingBins.join(", ")}.\n` +
      `Ensure these tools are installed and accessible. Current PATH: ${AUGMENTED_PATH}`,
    );
  }
}

const ENOENT_RE = /ENOENT|no such file or directory|posix_spawn/i;

function isENOENT(err: unknown): boolean {
  if (err instanceof Error) {
    return ENOENT_RE.test(err.message) || (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  return false;
}

function formatENOENT(binary: string): string {
  return `ENOENT: '${binary}' not found on PATH.\n` +
    `Make sure '${binary}' is installed and accessible. Current PATH: ${AUGMENTED_PATH}`;
}

export {
  BOT_URL,
  SHARED_SECRET,
  WORKER_ID,
  dryRun,
  skipPermissions,
  skipPermissionsArg,
  ghToken,
  gitBotName,
  gitBotEmail,
  gitCoauthorName,
  gitCoauthorEmail,
  hasCoauthor,
  opencodeStallTimeoutMs,
  AUGMENTED_PATH,
  REQUIRED_BINARIES,
  requireBinaries,
  isENOENT,
  formatENOENT,
};

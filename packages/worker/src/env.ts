const {
  BOT_URL = "http://localhost:3000",
  SHARED_SECRET,
  WORKER_ID = "default",
  DRY_RUN,
  SKIP_PERMISSIONS = "true",
  PATH: ENV_PATH = process.env.PATH ?? "",
} = process.env;

const dryRun = DRY_RUN === "true";
const skipPermissions = SKIP_PERMISSIONS === "true";
const skipPermissionsArg = skipPermissions ? ["--dangerously-skip-permissions"] : [];

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
  AUGMENTED_PATH,
  REQUIRED_BINARIES,
  requireBinaries,
  isENOENT,
  formatENOENT,
};

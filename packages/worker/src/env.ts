const {
  BOT_URL = "http://localhost:3000",
  SHARED_SECRET,
  WORKER_ID = "default",
  DRY_RUN,
  SKIP_PERMISSIONS = "true",
} = process.env;

const dryRun = DRY_RUN === "true";
const skipPermissions = SKIP_PERMISSIONS === "true";
const skipPermissionsArg = skipPermissions ? ["--dangerously-skip-permissions"] : [];

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

export { BOT_URL, SHARED_SECRET, WORKER_ID, dryRun, skipPermissions, skipPermissionsArg };

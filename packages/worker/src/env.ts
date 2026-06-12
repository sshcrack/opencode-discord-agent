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

if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

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
};

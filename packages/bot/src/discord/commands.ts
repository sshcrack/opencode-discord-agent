import {
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  CommandInteraction,
  ChannelType,
  TextChannel,
  Message,
  Collection,
} from "discord.js";
import { prisma } from "../db";
import { runFallback, checkWorkerOnline } from "./fallback";
import { existsSync } from "fs";

export const commands = [
  new SlashCommandBuilder()
    .setName("repo")
    .setDescription("Manage repositories")
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("add")
        .setDescription("Register a new repository")
        .addStringOption(o => o.setName("slug").setDescription("Human-readable slug").setRequired(true))
        .addStringOption(o => o.setName("path").setDescription("Absolute path on filesystem").setRequired(true)),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("remove")
        .setDescription("Remove a repository record")
        .addStringOption(o =>
          o.setName("slug").setDescription("Repository slug").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("list")
        .setDescription("List all registered repositories"),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("set-default")
        .setDescription("Set the default repository")
        .addStringOption(o =>
          o.setName("slug").setDescription("Repository slug").setRequired(true).setAutocomplete(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("create-report")
    .setDescription("Create a new report thread")
    .addStringOption(o =>
      o
        .setName("kind")
        .setDescription("Type of report")
        .setRequired(true)
        .addChoices(
          { name: "Bug", value: "bug" },
          { name: "Feature", value: "feature" },
          { name: "Refactor", value: "refactor" },
          { name: "Other", value: "other" },
        ),
    )
    .addStringOption(o =>
      o
        .setName("repo")
        .setDescription("Repository slug (defaults to default)")
        .setRequired(false)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("submit")
    .setDescription("Submit the current report thread as a job")
    .addBooleanOption(o =>
      o.setName("auto").setDescription("Override auto-mode for this job").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("set-auto")
    .setDescription("Set the global default for auto-mode")
    .addStringOption(o =>
      o
        .setName("mode")
        .setDescription("Auto mode")
        .setRequired(true)
        .addChoices(
          { name: "On", value: "on" },
          { name: "Off", value: "off" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("set-verbose")
    .setDescription("Toggle verbose status reporting in threads")
    .addStringOption(o =>
      o
        .setName("mode")
        .setDescription("Verbose mode")
        .setRequired(true)
        .addChoices(
          { name: "On (all steps)", value: "on" },
          { name: "Off (success/error only)", value: "off" },
        ),
    ),
];

export async function handleCommand(interaction: CommandInteraction) {
  const { commandName } = interaction;
  console.log("[handleCommand] Dispatching", commandName, "for user", interaction.user.tag);

  if (commandName === "repo") await handleRepoCommand(interaction);
  else if (commandName === "create-report") await handleCreateReport(interaction);
  else if (commandName === "submit") await handleSubmit(interaction);
  else if (commandName === "set-auto") await handleSetAuto(interaction);
  else if (commandName === "set-verbose") await handleSetVerbose(interaction);
  else console.warn("[handleCommand] Unknown command:", commandName);
}

async function handleRepoCommand(interaction: CommandInteraction) {
  if (!interaction.isChatInputCommand()) return;
  const subcommand = interaction.options.getSubcommand();
  console.log("[handleRepoCommand] Subcommand:", subcommand);

  if (subcommand === "add") {
    const slug = interaction.options.getString("slug", true);
    const path = interaction.options.getString("path", true);

    if (!existsSync(path)) {
      await interaction.reply({ content: `:x: Path \`${path}\` does not exist`, ephemeral: true });
      return;
    }

    const existing = await prisma.repository.findUnique({ where: { slug } });
    if (existing) {
      await interaction.reply({ content: `:x: Repository \`${slug}\` already exists`, ephemeral: true });
      return;
    }

    const repoCount = await prisma.repository.count();
    const repo = await prisma.repository.create({
      data: { slug, path, isDefault: repoCount === 0 },
    });

    await interaction.reply(`:white_check_mark: Repository \`${slug}\` added${repo.isDefault ? " (set as default)" : ""}`);
  } else if (subcommand === "remove") {
    const slug = interaction.options.getString("slug", true);
    const repo = await prisma.repository.findUnique({ where: { slug } });

    if (!repo) {
      await interaction.reply({ content: `:x: Repository \`${slug}\` not found`, ephemeral: true });
      return;
    }

    const wasDefault = repo.isDefault;
    await prisma.repository.delete({ where: { slug } });

    if (wasDefault) {
      const first = await prisma.repository.findFirst({ orderBy: { createdAt: "asc" } });
      if (first) {
        await prisma.repository.update({ where: { id: first.id }, data: { isDefault: true } });
      }
    }

    await interaction.reply(`:white_check_mark: Repository \`${slug}\` removed`);
  } else if (subcommand === "list") {
    const repos = await prisma.repository.findMany({ orderBy: { createdAt: "asc" } });

    if (repos.length === 0) {
      await interaction.reply("No repositories registered.");
      return;
    }

    const lines = repos.map(r => `${r.isDefault ? "⭐ " : ""}**${r.slug}** → \`${r.path}\``);
    await interaction.reply(`**Registered repositories:**\n${lines.join("\n")}`);
  } else if (subcommand === "set-default") {
    const slug = interaction.options.getString("slug", true);
    const repo = await prisma.repository.findUnique({ where: { slug } });

    if (!repo) {
      await interaction.reply({ content: `:x: Repository \`${slug}\` not found`, ephemeral: true });
      return;
    }

    await prisma.repository.updateMany({ data: { isDefault: false } });
    await prisma.repository.update({ where: { slug }, data: { isDefault: true } });

    await interaction.reply(`:white_check_mark: Default repository set to \`${slug}\``);
  }
}

async function handleCreateReport(interaction: CommandInteraction) {
  if (!interaction.isChatInputCommand()) return;
  const kind = interaction.options.getString("kind", true);
  const repoSlug = interaction.options.getString("repo");
  console.log("[handleCreateReport] kind:", kind, "repoSlug:", repoSlug);

  let slug = repoSlug;
  if (!slug) {
    const defaultRepo = await prisma.repository.findFirst({ where: { isDefault: true } });
    if (!defaultRepo) {
      await interaction.reply({
        content: ":x: No repositories registered. Add one with `/repo add`",
        ephemeral: true,
      });
      return;
    }
    slug = defaultRepo.slug;
  }

  const repo = await prisma.repository.findUnique({ where: { slug } });
  if (!repo) {
    await interaction.reply({ content: `:x: Repository \`${slug}\` not found`, ephemeral: true });
    return;
  }

  const ts = Date.now().toString(36);
  const threadName = `${kind}-${ts}`;

  const thread = await (interaction.channel as TextChannel).threads.create({
    name: threadName,
    type: ChannelType.PrivateThread,
    reason: `New ${kind} report`,
  });

  await prisma.reportThread.create({
    data: { threadId: thread.id, kind, repoSlug: slug },
  });

  await interaction.reply(`:white_check_mark: Report thread created: ${thread}`);
  await thread.send(
    `Repository: \`${slug}\` | Kind: **${kind}**\nUse \`/submit\` to submit this report as a job.`,
  );
}

async function handleSubmit(interaction: CommandInteraction) {
  if (!interaction.isChatInputCommand()) return;

  console.log("[handleSubmit] Channel type:", interaction.channel?.type, "isThread:", !!(interaction.channel as any)?.isThread?.());

  const thread = interaction.channel;
  if (!thread?.isThread()) {
    await interaction.reply({
      content: ":x: This command can only be used inside a report thread",
      ephemeral: true,
    });
    return;
  }

  const reportThread = await prisma.reportThread.findUnique({ where: { threadId: thread.id } });
  if (!reportThread) {
    await interaction.reply({ content: ":x: This thread is not a valid report thread", ephemeral: true });
    return;
  }

  const autoOverride = interaction.options.getBoolean("auto");
  const autoSetting = await prisma.setting.findUnique({ where: { key: "auto_mode" } });
  const autoMode = autoOverride ?? autoSetting?.value === "on";

  const messages: Message[] = [];
  let lastId: string | undefined;

  while (true) {
    const fetched: Collection<string, Message> = await thread.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
    if (fetched.size === 0) break;
    messages.push(...fetched.values());
    const last = fetched.last();
    if (!last) break;
    lastId = last.id;
    if (fetched.size < 100) break;
  }

  const context = messages
    .filter(m => !m.author.bot)
    .map(m => {
      const attachments = m.attachments.map(a => a.url);
      return `${m.author.tag}: ${m.content}${attachments.length ? ` [${attachments.join(", ")}]` : ""}`;
    })
    .reverse()
    .join("\n");

  const job = await prisma.job.create({
    data: {
      threadId: thread.id,
      repoSlug: reportThread.repoSlug,
      kind: reportThread.kind,
      status: "pending",
      autoMode,
    },
  });

  await interaction.reply(
    `ℹ️ Job #${job.id} created, waiting for a worker to pick it up...`,
  );

  const online = await checkWorkerOnline();
  if (!online) {
    await runFallback(job.id, context, reportThread.repoSlug, thread.id);
  }
}

async function handleSetAuto(interaction: CommandInteraction) {
  if (!interaction.isChatInputCommand()) return;
  const mode = interaction.options.getString("mode", true);

  await prisma.setting.upsert({
    where: { key: "auto_mode" },
    update: { value: mode },
    create: { key: "auto_mode", value: mode },
  });

  await interaction.reply(`:white_check_mark: Auto-mode set to **${mode}**`);
}

async function handleSetVerbose(interaction: CommandInteraction) {
  if (!interaction.isChatInputCommand()) return;
  const mode = interaction.options.getString("mode", true);

  await prisma.setting.upsert({
    where: { key: "verbose_mode" },
    update: { value: mode },
    create: { key: "verbose_mode", value: mode },
  });

  await interaction.reply(
    `:white_check_mark: Verbose mode set to **${mode}** — ${
      mode === "on"
        ? "all agent steps will be posted to threads"
        : "only success/error messages will be posted"
    }`,
  );
}

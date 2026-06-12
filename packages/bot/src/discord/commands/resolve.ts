import { SlashCommandBuilder, CommandInteraction, ChannelType, TextChannel } from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";

const GITHUB_ISSUE_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/i;

interface ResolvedRepo {
  slug: string;
  path: string;
}

async function resolveRepoFromChannel(channelId: string): Promise<ResolvedRepo | null> {
  const bound = await prisma.repository.findFirst({ where: { channelId } });
  return bound ? { slug: bound.slug, path: bound.path } : null;
}

async function resolveDefaultRepo(): Promise<ResolvedRepo | null> {
  const def = await prisma.repository.findFirst({ where: { isDefault: true } });
  return def ? { slug: def.slug, path: def.path } : null;
}

async function resolveRepoFromUrl(owner: string, repoName: string): Promise<ResolvedRepo | null> {
  const bySlug = await prisma.repository.findUnique({ where: { slug: repoName } });
  if (bySlug) return { slug: bySlug.slug, path: bySlug.path };

  const allRepos = await prisma.repository.findMany();
  for (const r of allRepos) {
    if (r.originUrl && r.originUrl.includes(`${owner}/${repoName}`)) {
      return { slug: r.slug, path: r.path };
    }
  }

  return null;
}

function parseIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } | null {
  const m = url.match(GITHUB_ISSUE_RE);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, issueNumber: parseInt(m[3]!, 10) };
}

export class ResolveCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("resolve")
    .setDescription("Create a fix job from a GitHub issue URL or short description")
    .addStringOption(o =>
      o
        .setName("issue")
        .setDescription("GitHub issue URL (e.g. https://github.com/owner/repo/issues/123) or short description")
        .setRequired(true),
    )
    .addBooleanOption(o =>
      o.setName("auto").setDescription("Override auto-mode for this job").setRequired(false),
    )
    .addBooleanOption(o =>
      o.setName("quick").setDescription("Skip planning, build directly").setRequired(false),
    );

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;

    const issueInput = interaction.options.getString("issue", true);
    const autoOverride = interaction.options.getBoolean("auto");
    const quickOverride = interaction.options.getBoolean("quick");

    const autoSetting = await prisma.setting.findUnique({ where: { key: "auto_mode" } });
    const autoMode = autoOverride ?? autoSetting?.value === "on";

    const quickSetting = await prisma.setting.findUnique({ where: { key: "quick_mode" } });
    const quickMode = quickOverride ?? quickSetting?.value === "on";

    // Must be used in a guild text channel (need to create a thread)
    if (
      !interaction.channel ||
      !interaction.channel.isTextBased() ||
      interaction.channel.isThread() ||
      !("threads" in interaction.channel)
    ) {
      await interaction.reply({
        content: ":x: This command must be used in a guild text channel",
        ephemeral: true,
      });
      return;
    }

    const parsed = parseIssueUrl(issueInput);

    let repo: ResolvedRepo;
    let context: string;
    let issueNumber: number | null = null;
    let threadName: string;

    if (parsed) {
      repo = await resolveRepoFromUrl(parsed.owner, parsed.repo);
      if (!repo) {
        await interaction.reply({
          content: `:x: No repository found matching \`${parsed.owner}/${parsed.repo}\`. Register it with \`/repo add\``,
          ephemeral: true,
        });
        return;
      }
      issueNumber = parsed.issueNumber;
      context = `Resolve GitHub issue: ${issueInput}`;
      threadName = `resolve #${parsed.issueNumber}`;
    } else {
      repo =
        (await resolveRepoFromChannel(interaction.channelId)) ??
        (await resolveDefaultRepo());

      if (!repo) {
        await interaction.reply({
          content: ":x: No repositories registered. Add one with `/repo add` first, or provide a GitHub issue URL",
          ephemeral: true,
        });
        return;
      }

      context = `Resolve: ${issueInput}`;
      threadName = `resolve-${Date.now().toString(36)}`;
    }

    const channel = interaction.channel as TextChannel;
    const thread = await channel.threads.create({
      name: threadName,
      type: ChannelType.GuildPrivateThread,
      reason: `Fix job for ${repo.slug}`,
    });

    await prisma.reportThread.create({
      data: {
        threadId: thread.id,
        kind: "bug",
        repoSlug: repo.slug,
      },
    });

    await prisma.job.create({
      data: {
        threadId: thread.id,
        repoSlug: repo.slug,
        kind: "bug",
        status: "pending",
        autoMode,
        quickMode,
        context,
        reporterId: interaction.user.id,
        issueNumber,
      },
    });

    await thread.members.add(interaction.user.id);

    await interaction.reply(`:white_check_mark: Fix job created — ${thread}`);

    const kindLabel = parsed ? `issue #${parsed.issueNumber}` : "bug fix";
    await thread.send(
      `Repository: \`${repo.slug}\` | Kind: **bug** | ${kindLabel}\nℹ️ Job created, waiting for worker...\n\`\`\`\n${issueInput}\n\`\`\``,
    );
  }
}

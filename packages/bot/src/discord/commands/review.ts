import { SlashCommandBuilder, CommandInteraction, ChannelType, TextChannel } from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";

const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/i;

interface ResolvedRepo {
  slug: string;
  path: string;
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

function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
  const m = url.match(PR_URL_RE);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, prNumber: parseInt(m[3]!, 10) };
}

export class ReviewCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("review")
    .setDescription("Review a GitHub PR, fix issues, and merge")
    .addStringOption(o =>
      o
        .setName("pr_url")
        .setDescription("GitHub PR URL (e.g. https://github.com/owner/repo/pull/123)")
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

    const prUrlInput = interaction.options.getString("pr_url", true);
    const autoOverride = interaction.options.getBoolean("auto");
    const quickOverride = interaction.options.getBoolean("quick");

    const parsed = parsePrUrl(prUrlInput);
    if (!parsed) {
      await interaction.reply({
        content: ":x: Invalid PR URL. Expected format: `https://github.com/owner/repo/pull/N`",
        ephemeral: true,
      });
      return;
    }

    const repo = await resolveRepoFromUrl(parsed.owner, parsed.repo);
    if (!repo) {
      await interaction.reply({
        content: `:x: No repository found matching \`${parsed.owner}/${parsed.repo}\`. Register it with \`/repo add\``,
        ephemeral: true,
      });
      return;
    }

    const autoSetting = await prisma.setting.findUnique({ where: { key: "auto_mode" } });
    const autoMode = autoOverride ?? autoSetting?.value === "on";
    const quickSetting = await prisma.setting.findUnique({ where: { key: "quick_mode" } });
    const quickMode = quickOverride ?? quickSetting?.value === "on";

    // Determine target thread
    let threadId: string;

    if (interaction.channel?.isThread()) {
      threadId = interaction.channel.id;

      const thread = await prisma.reportThread.findUnique({ where: { threadId } });
      if (thread?.closedAt) {
        await interaction.reply({
          content: ":x: This thread is closed",
          ephemeral: true,
        });
        return;
      }

      const activeStatuses: import("../../db/generated/client").Job["status"][] = [
        "pending", "claimed", "planning", "plan_ready", "approved", "building",
      ];
      const existingActive = await prisma.job.findFirst({
        where: { threadId, status: { in: activeStatuses } },
      });
      if (existingActive) {
        await interaction.reply({
          content: ":x: There's already an active job in this thread",
          ephemeral: true,
        });
        return;
      }
    } else if (
      interaction.channel &&
      interaction.channel.isTextBased() &&
      !interaction.channel.isThread() &&
      "threads" in interaction.channel
    ) {
      const channel = interaction.channel as TextChannel;
      const threadName = `review-${parsed.owner}/${parsed.repo}#${parsed.prNumber}`;
      const thread = await channel.threads.create({
        name: threadName,
        type: ChannelType.GuildPrivateThread,
        reason: `Review PR for ${repo.slug}`,
      });

      await prisma.reportThread.create({
        data: {
          threadId: thread.id,
          kind: "other",
          repoSlug: repo.slug,
        },
      });

      threadId = thread.id;
      await thread.members.add(interaction.user.id);
    } else {
      await interaction.reply({
        content: ":x: This command must be used in a guild text channel or thread",
        ephemeral: true,
      });
      return;
    }

    await prisma.job.create({
      data: {
        threadId,
        repoSlug: repo.slug,
        kind: "other",
        status: "pending",
        context: "review-merge",
        prUrl: prUrlInput,
        reporterId: interaction.user.id,
        autoMode,
        quickMode,
        parentJobId: null,
      },
    });

    await interaction.reply(`✅ Review job created for ${prUrlInput} — <#${threadId}>`);
  }
}

import { SlashCommandBuilder, CommandInteraction, ChannelType, TextChannel } from "discord.js";
import type { ReportKind } from "../../db/generated/client";
import { prisma } from "../../db";
import { Command } from "./Command";

export class CreateReportCommand extends Command {
  data = new SlashCommandBuilder()
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
    ) as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    const kind = interaction.options.getString("kind", true);
    const repoSlug = interaction.options.getString("repo");
    console.log("[CreateReportCommand] kind:", kind, "repoSlug:", repoSlug);

    if (!interaction.channel || !interaction.channel.isTextBased() || interaction.channel.isThread() || !("threads" in interaction.channel)) {
      await interaction.reply({
        content: ":x: This command must be used in a guild text channel",
        ephemeral: true,
      });
      return;
    }

    const channelId = interaction.channelId;

    // Check if this channel is bound to a repository
    const boundRepo = await prisma.repository.findFirst({ where: { channelId } });

    if (boundRepo) {
      // Channel is repo-specific — auto-use that repo
      if (repoSlug && repoSlug !== boundRepo.slug) {
        await interaction.reply({
          content: `:x: This channel is bound to \`${boundRepo.slug}\`. Use the main channel or the dedicated channel for \`${repoSlug}\` to report on that repository.`,
          ephemeral: true,
        });
        return;
      }

      const ts = Date.now().toString(36);
      const threadName = `${kind}-${ts}`;

      const channel = interaction.channel as TextChannel;
      const thread = await channel.threads.create({
        name: threadName,
        type: ChannelType.PrivateThread,
        reason: `New ${kind} report for ${boundRepo.slug}`,
      });

      await prisma.reportThread.create({
        data: { threadId: thread.id, kind: kind as ReportKind, repoSlug: boundRepo.slug },
      });

      await interaction.reply(`:white_check_mark: Report thread created: ${thread}`);
      await thread.send(
        `Repository: \`${boundRepo.slug}\` | Kind: **${kind}**\nUse \`/submit\` to submit this report as a job.`,
      );
      return;
    }

    // Not in a repo-specific channel — use explicit or default repo
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

    const channel = interaction.channel as TextChannel;
    const thread = await channel.threads.create({
      name: threadName,
      type: ChannelType.PrivateThread,
      reason: `New ${kind} report`,
    });

    await prisma.reportThread.create({
      data: { threadId: thread.id, kind: kind as ReportKind, repoSlug: slug },
    });

    await interaction.reply(`:white_check_mark: Report thread created: ${thread}`);
    await thread.send(
      `Repository: \`${slug}\` | Kind: **${kind}**\nUse \`/submit\` to submit this report as a job.`,
    );
  }
}

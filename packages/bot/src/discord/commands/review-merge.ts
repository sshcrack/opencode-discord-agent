import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";

export class ReviewMergeCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("review-merge")
    .setDescription("Run review agent on the PR, fix issues, and merge");

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.channel || !interaction.channel.isThread()) {
      await interaction.reply({
        content: ":x: This command must be used in a thread",
        ephemeral: true,
      });
      return;
    }

    const threadId = interaction.channel.id;

    const parentJob = await prisma.job.findFirst({
      where: { threadId, status: "done", prUrl: { not: null } },
      orderBy: { createdAt: "desc" },
    });

    if (!parentJob || !parentJob.prUrl) {
      await interaction.reply({
        content: ":x: No completed job with a PR found in this thread",
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

    await prisma.job.create({
      data: {
        threadId,
        repoSlug: parentJob.repoSlug,
        kind: "other",
        status: "pending",
        context: "review-merge",
        reporterId: interaction.user.id,
        autoMode: true,
        quickMode: true,
        parentJobId: parentJob.id,
      },
    });

    await interaction.reply(`✅ Review & Merge job created! Waiting for worker... ${interaction.channel}`);
  }
}

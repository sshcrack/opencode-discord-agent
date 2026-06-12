import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { prisma } from "../../db";
import { closeThread } from "../helpers";
import { Command } from "./Command";

export class CloseCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close this thread and cancel any active job") as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply({ ephemeral: true });

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.editReply(":x: This command can only be used inside a report thread");
      return;
    }

    const reportThread = await prisma.reportThread.findUnique({ where: { threadId: thread.id } });
    if (!reportThread) {
      await interaction.editReply(":x: This thread is not a valid report thread");
      return;
    }

    if (reportThread.closedAt) {
      await interaction.editReply(":information_source: This thread is already closed");
      return;
    }

    // Cancel any non-terminal jobs in this thread
    const activeJobs = await prisma.job.findMany({
      where: {
        threadId: thread.id,
        status: { notIn: ["done", "failed", "cancelled"] },
      },
    });

    for (const job of activeJobs) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "cancelled" },
      });
    }

    // Mark thread as closed in DB
    await prisma.reportThread.update({
      where: { id: reportThread.id },
      data: { closedAt: new Date() },
    });

    // Lock and archive the Discord thread
    await closeThread(thread.id);

    const cancelMsg = activeJobs.length > 0
      ? ` Cancelled ${activeJobs.length} active job(s).`
      : "";

    await interaction.editReply(`:lock: Thread closed.${cancelMsg}`);

    if (activeJobs.length > 0) {
      await thread.send(`:lock: Thread closed — ${activeJobs.length} active job(s) cancelled.`);
    } else {
      await thread.send(":lock: Thread closed.");
    }
  }
}

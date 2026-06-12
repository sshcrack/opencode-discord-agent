import { SlashCommandBuilder, CommandInteraction, Message, Collection, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } from "discord.js";
import { prisma } from "../../db";
import { runFallback, checkWorkerOnline } from "../fallback";
import { buildContext } from "../context";
import { Command } from "./Command";

export class SubmitCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("submit")
    .setDescription("Submit the current report thread as a job")
    .addBooleanOption(o =>
      o.setName("auto").setDescription("Override auto-mode for this job").setRequired(false),
    )
    .addBooleanOption(o =>
      o.setName("quick").setDescription("Skip planning, build directly").setRequired(false),
    );

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;

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

    if (reportThread.closedAt) {
      await interaction.reply({
        content: ":lock: This thread has been closed. Create a new report thread with `/create-report`",
        ephemeral: true,
      });
      return;
    }

    // Unarchive thread if it was previously archived
    if (thread.archived || thread.locked) {
      await thread.setLocked(false);
      await thread.setArchived(false);
    }

    // Check if there's a completed job in this thread (for follow-up)
    const lastCompletedJob = await prisma.job.findFirst({
      where: { threadId: thread.id, status: "done" },
      orderBy: { createdAt: "desc" },
    });

    const autoOverride = interaction.options.getBoolean("auto");
    const autoSetting = await prisma.setting.findUnique({ where: { key: "auto_mode" } });
    const autoMode = autoOverride ?? autoSetting?.value === "on";

    const quickOverride = interaction.options.getBoolean("quick");
    const quickSetting = await prisma.setting.findUnique({ where: { key: "quick_mode" } });
    const quickMode = quickOverride ?? quickSetting?.value === "on";

    let isFollowUp = false;

    if (lastCompletedJob) {
      const continueBtn = new ButtonBuilder()
        .setCustomId("continue_yes")
        .setLabel("Yes, continue")
        .setStyle(ButtonStyle.Success);

      const freshBtn = new ButtonBuilder()
        .setCustomId("continue_no")
        .setLabel("No, start fresh")
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(continueBtn, freshBtn);

      const reply = await interaction.reply({
        content: `A previous job (#${lastCompletedJob.id}) was completed in this thread. Continue that session with your new messages?`,
        components: [row],
        ephemeral: true,
      });

      let buttonInteraction;
      try {
        buttonInteraction = await reply.awaitMessageComponent({
          filter: i => i.user.id === interaction.user.id,
          componentType: ComponentType.Button,
          time: 30_000,
        });
      } catch {
        await interaction.editReply({ content: "❌ Timed out — no changes submitted", components: [] });
        return;
      }

      isFollowUp = buttonInteraction.customId === "continue_yes";
      await buttonInteraction.update({
        content: isFollowUp ? "ℹ️ Continuing previous session..." : "ℹ️ Creating new job...",
        components: [],
      });
    } else {
      // No completed job — reply and proceed immediately
      await interaction.reply("ℹ️ Collecting messages and creating job...");
    }

    const messages: Message[] = [];
    let lastId: string | undefined;

    while (true) {
      const fetched: Collection<string, Message> = await thread.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
      if (fetched.size === 0) break;
      messages.unshift(...[...fetched.values()].toReversed());
      const last = fetched.last();
      if (!last) break;
      lastId = last.id;
      if (fetched.size < 100) break;
    }

    // For follow-ups, only include messages after the parent job was created
    let contextMessages = messages;
    if (isFollowUp && lastCompletedJob) {
      const afterTimestamp = lastCompletedJob.createdAt.getTime();
      contextMessages = messages.filter(m => m.createdTimestamp >= afterTimestamp);
    }

    const context = await buildContext(contextMessages);

    const job = await prisma.job.create({
      data: {
        threadId: thread.id,
        repoSlug: reportThread.repoSlug,
        kind: reportThread.kind,
        status: "pending",
        autoMode,
        quickMode,
        context,
        reporterId: interaction.user.id,
        parentJobId: isFollowUp ? lastCompletedJob!.id : null,
      },
    });

    await thread.send(`ℹ️ Job #${job.id} created, waiting for worker...`);

    const online = await checkWorkerOnline();
    if (!online) {
      await runFallback(job.id, context, reportThread.repoSlug, thread.id);
    }
  }
}

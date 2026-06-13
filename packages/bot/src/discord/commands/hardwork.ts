import { SlashCommandBuilder, CommandInteraction, Message, Collection, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } from "discord.js";
import { prisma } from "../../db";
import { runFallback, checkWorkerOnline } from "../fallback";
import { buildContext } from "../context";
import { Command } from "./Command";

export class HardworkCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("hardwork")
    .setDescription("Run N parallel plan agents and synthesize the best plan")
    .addIntegerOption(o =>
      o.setName("plan_count").setDescription("Number of parallel plan agents (1-10, default: 3)").setRequired(false).setMinValue(1).setMaxValue(10),
    )
    .addBooleanOption(o =>
      o.setName("auto").setDescription("Override auto-mode for this job").setRequired(false),
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

    if (thread.archived || thread.locked) {
      await thread.setLocked(false);
      await thread.setArchived(false);
    }

    const lastCompletedJob = await prisma.job.findFirst({
      where: { threadId: thread.id, status: "done" },
      orderBy: { createdAt: "desc" },
    });

    const planCount = interaction.options.getInteger("plan_count") ?? 3;
    const autoOverride = interaction.options.getBoolean("auto");
    const autoSetting = await prisma.setting.findUnique({ where: { key: "auto_mode" } });
    const autoMode = autoOverride ?? autoSetting?.value === "on";

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
        hardwork: true,
        parallelPlanCount: planCount,
        autoMode,
        context,
        reporterId: interaction.user.id,
        parentJobId: isFollowUp ? lastCompletedJob!.id : null,
      },
    });

    await thread.send(`ℹ️ Job #${job.id} created (hardwork: ${planCount} parallel plans), waiting for worker...`);

    const online = await checkWorkerOnline();
    if (!online) {
      await runFallback(job.id, context, reportThread.repoSlug, thread.id);
    }
  }
}

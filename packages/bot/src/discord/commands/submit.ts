import { SlashCommandBuilder, CommandInteraction, Message, Collection } from "discord.js";
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
    ) as SlashCommandBuilder;

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

    const autoOverride = interaction.options.getBoolean("auto");
    const autoSetting = await prisma.setting.findUnique({ where: { key: "auto_mode" } });
    const autoMode = autoOverride ?? autoSetting?.value === "on";

    const quickOverride = interaction.options.getBoolean("quick");
    const quickSetting = await prisma.setting.findUnique({ where: { key: "quick_mode" } });
    const quickMode = quickOverride ?? quickSetting?.value === "on";

    const messages: Message[] = [];
    let lastId: string | undefined;

    while (true) {
      const fetched: Collection<string, Message> = await thread.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
      if (fetched.size === 0) break;
      messages.unshift(...fetched.reverse().values());
      const last = fetched.last();
      if (!last) break;
      lastId = last.id;
      if (fetched.size < 100) break;
    }

    const context = await buildContext(messages);

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
      },
    });

    await interaction.reply(`ℹ️ Job #${job.id} created, waiting for worker...`);

    const online = await checkWorkerOnline();
    if (!online) {
      await runFallback(job.id, context, reportThread.repoSlug, thread.id);
    }
  }
}

import { SlashCommandBuilder, CommandInteraction, AttachmentBuilder } from "discord.js";
import JSZip from "jszip";
import { Command } from "./Command";
import { prisma } from "../../db";
import { botLog } from "../../logging";

export class DebugCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("debug")
    .setDescription("Generate a debug zip with DB state and full chat log");

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;

    await interaction.deferReply();

    let chatLog = "";
    const channel = interaction.channel;

    if (channel?.isThread()) {
      botLog("[DebugCommand] Fetching messages from thread", channel.id);
      const lines: string[] = [];
      let lastId: string | undefined;
      let batch;
      do {
        batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
        for (const msg of batch.values()) {
          lines.push(`[${msg.createdAt.toISOString()}] ${msg.author.tag} (${msg.author.id}): ${msg.content}`);
          for (const a of msg.attachments.values()) {
            lines.push(`  [Attachment: ${a.name}](${a.url})`);
          }
        }
        lastId = batch.last()?.id;
      } while (batch.size === 100);

      chatLog = lines.toReversed().join("\n");
    }

    const repositories = await prisma.repository.findMany({ orderBy: { id: "asc" } });
    const reportThreads = await prisma.reportThread.findMany({ orderBy: { id: "asc" } });
    const jobs = await prisma.job.findMany({ orderBy: { id: "asc" } });
    const settings = await prisma.setting.findMany({ orderBy: { id: "asc" } });

    const zip = new JSZip();
    zip.file("chat_log.txt", chatLog || "(not a thread or no messages)");
    zip.file("db_repositories.json", JSON.stringify(repositories, null, 2));
    zip.file("db_report_threads.json", JSON.stringify(reportThreads, null, 2));
    zip.file("db_jobs.json", JSON.stringify(jobs, null, 2));
    zip.file("db_settings.json", JSON.stringify(settings, null, 2));

    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const attachment = new AttachmentBuilder(buf, { name: `debug-${interaction.id}.zip` });

    await interaction.editReply({ files: [attachment], content: "🧵 Debug data attached." });
  }
}

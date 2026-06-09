import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { prisma } from "../db";
import { ThreadStatus, JobStatus, type JobPayload } from "@discord-agent/shared";
import { handleFallback } from "../fallback";

export const data = new SlashCommandBuilder()
  .setName("submit")
  .setDescription("Submit the collected context for processing")
  .addBooleanOption((opt) =>
    opt
      .setName("auto")
      .setDescription("Override auto-mode for this job (default: global setting)")
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const threadId = interaction.channelId;
  const thread = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!thread) {
    await interaction.reply({
      content: "No report thread found here. First use `/create-report`.",
      ephemeral: true,
    });
    return;
  }

  if (thread.status !== ThreadStatus.COLLECTING) {
    await interaction.reply({
      content: `Thread is in status "${thread.status}". Can only submit from COLLECTING.`,
      ephemeral: true,
    });
    return;
  }

  const repo = await prisma.repository.findUnique({ where: { name: thread.repo } });
  if (!repo) {
    await interaction.reply({
      content: `Repository **${thread.repo}** is no longer registered. Admin must run \`/add-repository\` first.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  if (!interaction.channel?.isThread()) {
    await interaction.editReply("Not a thread channel.");
    return;
  }

  const messages = await interaction.channel.messages.fetch({ limit: 100 });
  const sorted = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const contextParts: string[] = [];
  const fileUrls: string[] = [];

  for (const msg of sorted.values()) {
    if (msg.author.bot) continue;
    contextParts.push(`[${msg.author.displayName}]: ${msg.content}`);

    for (const attachment of msg.attachments.values()) {
      fileUrls.push(attachment.url);
    }
  }

  const context = contextParts.join("\n");

  const autoOverride = interaction.options.getBoolean("auto");
  let autoMode: boolean;

  if (autoOverride !== null) {
    autoMode = autoOverride;
  } else if (thread.autoMode !== null && thread.autoMode !== undefined) {
    autoMode = thread.autoMode;
  } else {
    const setting = await prisma.setting.findUnique({
      where: { key: "auto_mode" },
    });
    autoMode = setting?.value === "true";
  }

  const payload: JobPayload = {
    repo: thread.repo,
    kind: thread.kind,
    context,
    fileUrls,
    autoMode,
  };

  const job = await prisma.job.create({
    data: {
      threadId,
      payload: JSON.stringify(payload),
      status: JobStatus.PENDING,
    },
  });

  await prisma.thread.update({
    where: { id: threadId },
    data: { status: ThreadStatus.SUBMITTED },
  });

  const onlineWorker = await prisma.worker.findFirst({
    where: {
      status: "ONLINE",
      lastSeen: { gte: new Date(Date.now() - 60_000) },
    },
  });

  if (onlineWorker) {
    await interaction.editReply("⏳ Job queued — worker will pick it up shortly.");
  } else {
    await interaction.editReply("⚙️ No worker online — using GitHub fallback…");
    await handleFallback(job.id, payload, threadId);
  }
}

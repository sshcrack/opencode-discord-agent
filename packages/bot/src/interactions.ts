import {
  type Interaction,
  type Message,
  Events,
  Client,
} from "discord.js";
import { prisma } from "./db";
import { ThreadStatus, JobStatus } from "@discord-agent/shared";
import { approvalMap } from "./router";

const awaitingSuggestion = new Map<string, { userId: string; timeout: ReturnType<typeof setTimeout> }>();

export function setupInteractions(client: Client) {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return;

    const [action, jobId] = interaction.customId.split(":");
    if (!jobId) return;

    switch (action) {
      case "approve":
        await handleApprove(interaction, jobId);
        break;
      case "suggest":
        await handleSuggest(interaction, jobId);
        break;
      case "cancel":
        await handleCancel(interaction, jobId);
        break;
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!message.channel.isThread?.()) return;

    const entry = awaitingSuggestion.get(message.channelId);
    if (!entry || message.author.id !== entry.userId) return;

    clearTimeout(entry.timeout);
    awaitingSuggestion.delete(message.channelId);

    const job = await prisma.job.findUnique({
      where: { threadId: message.channelId },
    });
    if (!job || !job.planSessionId) return;

    approvalMap.set(message.channelId, {
      approved: false,
      cancelled: false,
      suggestion: {
        text: message.content,
        sessionId: job.planSessionId,
      },
    });

    await message.react("\u270f\ufe0f");
  });
}

async function handleApprove(
  interaction: import("discord.js").ButtonInteraction,
  jobId: string,
) {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.BUILDING },
  });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (job) {
    await prisma.thread.update({
      where: { id: job.threadId },
      data: { status: ThreadStatus.BUILDING },
    });
  }

  approvalMap.set(jobId, { approved: true, cancelled: false });

  await interaction.update({
    content: "\u2705 Approved — building\u2026",
    components: [],
  });
}

async function handleSuggest(
  interaction: import("discord.js").ButtonInteraction,
  jobId: string,
) {
  const existing = awaitingSuggestion.get(interaction.channelId);
  if (existing) clearTimeout(existing.timeout);

  const timeout = setTimeout(() => {
    awaitingSuggestion.delete(interaction.channelId);
  }, 5 * 60 * 1000);

  awaitingSuggestion.set(interaction.channelId, {
    userId: interaction.user.id,
    timeout,
  });

  await interaction.update({
    content: "\u270f\ufe0f Send your suggested changes as a reply in this thread.",
    components: [],
  });
}

async function handleCancel(
  interaction: import("discord.js").ButtonInteraction,
  jobId: string,
) {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.CANCELLED },
  });
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (job) {
    await prisma.thread.update({
      where: { id: job.threadId },
      data: { status: ThreadStatus.CANCELLED },
    });
  }

  approvalMap.set(jobId, { approved: false, cancelled: true });

  await interaction.update({
    content: "\u274c Cancelled.",
    components: [],
  });
}

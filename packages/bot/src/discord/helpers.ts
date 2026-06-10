import { Client, TextChannel, ThreadChannel } from "discord.js";
import { prisma } from "../db";

type TextishChannel = TextChannel | ThreadChannel;

export function getClient() {
  return (globalThis as any).__discord_client as Client<boolean>;
}

export async function postToThread(threadId: string, content: string) {
  try {
    const channel = await getClient().channels.fetch(threadId);
    if (channel?.isTextBased()) {
      await (channel as TextishChannel).send(content);
    }
  } catch (err) {
    console.error(`Failed to post to thread ${threadId}:`, err);
  }
}

export async function upsertStatusMessage(
  jobId: number,
  threadId: string,
  content: string,
): Promise<void> {
  try {
    const ch = await getClient().channels.fetch(threadId);
    if (!ch?.isTextBased()) return;
    const channel = ch as TextishChannel;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;

    let messageId = job.statusMessageId;

    if (messageId) {
      try {
        const msg = await channel.messages.fetch(messageId);
        await msg.edit(content);
        return;
      } catch {
        messageId = null;
      }
    }

    const msg = await channel.send(content);
    await prisma.job.update({
      where: { id: jobId },
      data: { statusMessageId: msg.id },
    });
  } catch (err) {
    console.error(`Failed to upsert status message for job ${jobId}:`, err);
  }
}

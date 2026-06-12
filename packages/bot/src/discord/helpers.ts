import { Client, ActionRowBuilder, ButtonBuilder } from "discord.js";
import { prisma } from "../db";
import { botError } from "../logging";

const DISCORD_UNKNOWN_CHANNEL = 10003;

declare global {
  var __discord_client: Client<boolean>;
}

export function getClient() {
  return globalThis.__discord_client;
}

async function handleStaleThread(threadId: string, action: string) {
  botError(`[Stale thread] ${action}: thread ${threadId} not found on Discord, marking associated jobs as failed`);
  try {
    const terminal: import("../db/generated/client").JobStatus[] = ["done", "failed", "cancelled"];
    await prisma.job.updateMany({
      where: { threadId, status: { notIn: terminal } },
      data: { status: "failed" },
    });
  } catch (dbErr) {
    botError(`[Stale thread] Failed to update jobs for thread ${threadId}:`, dbErr);
  }
}

export async function discordFetch(threadId: string) {
  try {
    const channel = await getClient().channels.fetch(threadId);
    return channel;
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === DISCORD_UNKNOWN_CHANNEL) {
      await handleStaleThread(threadId, "fetch");
      return null;
    }
    throw err;
  }
}

const DISCORD_CONTENT_LIMIT = 2000;

function truncateContent(content: string): string {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  return content.slice(0, DISCORD_CONTENT_LIMIT - 100) + `\n\n… *(truncated, ${content.length - DISCORD_CONTENT_LIMIT + 100} chars removed)*`;
}

export async function postToThread(threadId: string, content: string) {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      await channel.send(truncateContent(content));
    }
  } catch (err) {
    botError(`Failed to post to thread ${threadId}:`, err);
  }
}

export async function editMessage(threadId: string, messageId: string, content: string) {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit(truncateContent(content));
      return true;
    }
  } catch {
    // Message might be gone or permissions changed — fall through
  }
  return false;
}

export async function fetchLastMessage(threadId: string): Promise<string | null> {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      const messages = await channel.messages.fetch({ limit: 1 });
      const last = messages.first();
      return last?.id ?? null;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function closeThread(threadId: string) {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      await channel.setLocked(true);
      await channel.setArchived(true);
    }
  } catch (err) {
    botError(`Failed to close thread ${threadId}:`, err);
  }
}

export async function postToThreadWithComponents(threadId: string, row: ActionRowBuilder<ButtonBuilder>) {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      await channel.send({ components: [row] });
    }
  } catch (err) {
    botError(`Failed to post components to thread ${threadId}:`, err);
  }
}

export async function renameThread(threadId: string, name: string) {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      await channel.setName(name);
    }
  } catch (err) {
    botError(`Failed to rename thread ${threadId}:`, err);
  }
}

export async function closeThreadForJob(job: { id: number; threadId: string }) {
  const thread = await prisma.reportThread.findUnique({ where: { threadId: job.threadId } });
  if (!thread || thread.closedAt) return;

  await prisma.job.update({
    where: { id: job.id },
    data: { mergedAt: new Date() },
  });

  await prisma.reportThread.update({
    where: { id: thread.id },
    data: { closedAt: new Date() },
  });

  const channel = await discordFetch(job.threadId);
  const threadName = channel?.isThread() ? channel.name : null;
  if (threadName) {
    const prefix = threadName.startsWith("[Closed] ") ? "" : "[Closed] ";
    await renameThread(job.threadId, `${prefix}${threadName}`).catch(() => {});
  }

  await closeThread(job.threadId);
  await postToThread(job.threadId, "✅ PR merged — thread closed automatically");
}

export function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!.replace(/\.git$/, ""), prNumber: parseInt(match[3]!) };
}

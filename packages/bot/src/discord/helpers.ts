import { Client } from "discord.js";
import { prisma } from "../db";

const DISCORD_UNKNOWN_CHANNEL = 10003;

declare global {
  var __discord_client: Client<boolean>;
}

export function getClient() {
  return globalThis.__discord_client;
}

async function handleStaleThread(threadId: string, action: string) {
  console.error(`[Stale thread] ${action}: thread ${threadId} not found on Discord, marking associated jobs as failed`);
  try {
    const terminal: import("../db/generated/client").JobStatus[] = ["done", "failed", "cancelled"];
    await prisma.job.updateMany({
      where: { threadId, status: { notIn: terminal } },
      data: { status: "failed" },
    });
  } catch (dbErr) {
    console.error(`[Stale thread] Failed to update jobs for thread ${threadId}:`, dbErr);
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

export async function postToThread(threadId: string, content: string) {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      await channel.send(content);
    }
  } catch (err) {
    console.error(`Failed to post to thread ${threadId}:`, err);
  }
}

export async function closeThread(threadId: string) {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      await channel.setLocked(true);
      await channel.setArchived(true);
    }
  } catch (err) {
    console.error(`Failed to close thread ${threadId}:`, err);
  }
}

export async function renameThread(threadId: string, name: string) {
  try {
    const channel = await discordFetch(threadId);
    if (channel?.isThread()) {
      await channel.setName(name);
    }
  } catch (err) {
    console.error(`Failed to rename thread ${threadId}:`, err);
  }
}

import { Client } from "discord.js";

declare global {
  var __discord_client: Client<boolean>;
}

export function getClient() {
  return globalThis.__discord_client;
}

export async function postToThread(threadId: string, content: string) {
  try {
    const channel = await getClient().channels.fetch(threadId);
    if (channel?.isThread()) {
      await channel.send(content);
    }
  } catch (err) {
    console.error(`Failed to post to thread ${threadId}:`, err);
  }
}

export async function closeThread(threadId: string) {
  try {
    const channel = await getClient().channels.fetch(threadId);
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
    const channel = await getClient().channels.fetch(threadId);
    if (channel?.isThread()) {
      await channel.setName(name);
    }
  } catch (err) {
    console.error(`Failed to rename thread ${threadId}:`, err);
  }
}

import { Client, TextChannel, ThreadChannel } from "discord.js";

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

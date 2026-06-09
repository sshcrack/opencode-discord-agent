import { TextChannel, ThreadChannel } from "discord.js";
import { client } from '..';

type TextishChannel = TextChannel | ThreadChannel;

export async function postToThread(threadId: string, content: string) {
  try {
    const channel = await client.channels.fetch(threadId);
    if (channel?.isTextBased()) {
      await (channel as TextishChannel).send(content);
    }
  } catch (err) {
    console.error(`Failed to post to thread ${threadId}:`, err);
  }
}

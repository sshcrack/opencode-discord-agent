import { Message } from "discord.js";

const MAX_ATTACHMENT_SIZE = 100_000;

async function downloadAttachmentContent(
  url: string,
  filename: string,
): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    const isText =
      /^text\//.test(contentType) ||
      /^application\/json/.test(contentType) ||
      /^application\/xml/.test(contentType) ||
      /^application\/yaml/.test(contentType) ||
      /^application\/x-yaml/.test(contentType) ||
      /^application\/javascript/.test(contentType) ||
      /^application\/x-shellscript/.test(contentType) ||
      /^application\/octet-stream/.test(contentType) ||
      contentType.includes("charset=");

    if (!isText) return null;

    const text = await response.text();
    if (text.length > MAX_ATTACHMENT_SIZE) {
      return text.slice(0, MAX_ATTACHMENT_SIZE) + "\n\n[truncated...]";
    }

    return text;
  } catch {
    return null;
  }
}

export async function buildContext(messages: Message[]): Promise<string> {
  const sorted = messages
    .filter((m) => !m.author.bot)
    .reverse();

  const parts: string[] = [];

  for (const message of sorted) {
    let entry = `${message.author.tag}: ${message.content}`;

    if (message.attachments.size > 0) {
      for (const [, attachment] of message.attachments) {
        const name = attachment.name || "unnamed";
        const content = await downloadAttachmentContent(attachment.url, name);

        if (content !== null) {
          entry += `\n[file with name ${name}]\n\`\`\`\n# ${name}\n${content}\n\`\`\``;
        } else {
          entry += `\n[file with name ${name}](${attachment.url})`;
        }
      }
    }

    parts.push(entry);
  }

  return parts.join("\n");
}

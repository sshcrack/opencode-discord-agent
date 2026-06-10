import { Message } from "discord.js";

const MAX_ATTACHMENT_SIZE = 10_000;

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
      return null;
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
    let entry = message.content;

    if (message.attachments.size > 0) {
      const results = await Promise.all(
        message.attachments.map((attachment) => {
          const name = attachment.name || "unnamed";
          return downloadAttachmentContent(attachment.url, name).then(content => ({ name, url: attachment.url, content }));
        }),
      );

      for (const { name, url, content } of results) {
        if (content !== null) {
          entry += `\n[file with name ${name}]\n\`\`\`\n# ${name}\n${content}\n\`\`\``;
        } else {
          entry += `\n[file with name ${name}](${url})`;
        }
      }
    }

    parts.push(entry);
  }

  return parts.join("\n");
}

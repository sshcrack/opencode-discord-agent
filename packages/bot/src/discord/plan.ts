import { deflateSync, inflateSync } from "node:zlib";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { prisma } from "../db";
import { getClient } from './helpers';

const MARKDOWN_VIEWER_PREFIX = "https://markdownviewer.pages.dev/#share=";

async function makePlanUrl(content: string): Promise<string> {
  const compressed = deflateSync(content);
  const encoded = Buffer.from(compressed)
    .toString("base64url")
    .replace(/=+$/, "");
  const url = `${MARKDOWN_VIEWER_PREFIX}${encoded}&edit=1`;

  // If URL + surrounding text fits in Discord's 4096-char embed description, use it directly
  // (description overhead with ping is ~140 chars)
  if (url.length <= 3950) return url;

  // URL too long — try shortening via is.gd
  try {
    const shortUrl = await shortenUrl(url);
    if (shortUrl) return shortUrl;
  } catch {
    // fall through
  }

  // Fallback: truncate content and regenerate
  let truncated = content;
  for (let attempt = 0; attempt < 5; attempt++) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.7)) +
      "\n\n*... truncated ...*";
    const recompressed = deflateSync(truncated);
    const reencoded = Buffer.from(recompressed)
      .toString("base64url")
      .replace(/=+$/, "");
    const retryUrl = `${MARKDOWN_VIEWER_PREFIX}${reencoded}&edit=1`;
    if (retryUrl.length <= 3950) return retryUrl;
  }

  return url;
}

async function shortenUrl(url: string): Promise<string | null> {
  const res = await fetch(
    `https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`,
  );
  if (!res.ok) return null;
  const text = await res.text();
  return text.trim() || null;
}

/**
 * Follow an is.gd (or similar) short URL to get the real redirect target.
 */
async function resolveUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "manual" });
    const location = res.headers.get("location");
    if (location) return resolveUrl(location);
    return url;
  } catch {
    return null;
  }
}

/**
 * Decode a markdown viewer URL back to the original plan markdown.
 * Format: https://markdownviewer.pages.dev/#share={base64url(deflate(content))}&edit=1
 */
export function decodePlanUrl(url: string): string | null {
  try {
    const hashMatch = url.match(/#share=([A-Za-z0-9_-]+)/);
    if (!hashMatch?.[1]) return null;
    const compressed = Buffer.from(hashMatch[1], "base64url");
    return inflateSync(compressed).toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Given a URL (markdown viewer or shortened), extract the plan markdown.
 * Follows short URLs to resolve the real target first.
 */
export async function extractPlanFromUrl(url: string): Promise<string | null> {
  const trimmed = url.trim();

  // If it's already a markdown viewer URL, decode directly
  if (trimmed.includes(MARKDOWN_VIEWER_PREFIX.replace("https://", ""))) {
    return decodePlanUrl(trimmed);
  }

  // Otherwise try to follow redirect (e.g. is.gd) and decode the result
  const resolved = await resolveUrl(trimmed);
  if (!resolved || resolved === trimmed) return null;
  return decodePlanUrl(resolved);
}

export async function postPlan(
  job: { id: number; threadId: string; autoMode: boolean; reporterId: string | null },
  planMd: string,
) {
  const planUrl = await makePlanUrl(planMd);
  const ping = job.reporterId ? `<@${job.reporterId}> ` : "";

  const embed = new EmbedBuilder()
    .setTitle("📋 Planning Complete")
    .setDescription(
      `${ping}📝 [Open and edit the plan](${planUrl})\n` +
      `After editing, submit the updated plan using the link above, or use the buttons below.`
    )
    .setColor(0x5865f2);

  const ch = await getClient().channels.fetch(job.threadId);
  if (!ch) {
    return { success: false, error: "Thread not found" };
  }
  if (!ch.isThread()) {
    console.warn(`Channel ${job.threadId} is not a thread`);
    return { success: false, error: "Channel is not a thread" };
  }

  if (job.autoMode) {
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`cancel:${job.id}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    await ch.send({ embeds: [embed], components: [cancelRow] });
    const countdownMsg = await ch.send("⏳ Auto-approving in **10** seconds... (click Cancel to abort)");

    for (let i = 9; i >= 0; i--) {
      await Bun.sleep(1000);
      const currentJob = await prisma.job.findUnique({ where: { id: job.id } });
      if (!currentJob || currentJob.status !== "plan_ready") {
        await countdownMsg.edit("❌ Auto-approval cancelled.").catch(() => { });
        return { success: true };
      }
      await countdownMsg
        .edit(`⏳ Auto-approving in **${i}** seconds... (click Cancel to abort)`)
        .catch(() => { });
    }

    const finalJob = await prisma.job.findUnique({ where: { id: job.id } });
    if (finalJob?.status === "plan_ready") {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "approved" },
      });
      await countdownMsg.edit("✅ Auto-approved, proceeding to build...").catch(() => { });
      return { success: true, autoApproved: true };
    }

    return { success: true };
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${job.id}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`suggest:${job.id}`)
      .setLabel("Suggest changes")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`cancel:${job.id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );

  await ch.send({ embeds: [embed], components: [row] });

  return { success: true };
}

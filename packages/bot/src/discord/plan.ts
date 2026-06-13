import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { prisma } from "../db";
import { discordFetch } from './helpers';
import { botWarn } from '../logging';
import crypto from "node:crypto";

export async function postPlan(
  job: { id: number; threadId: string; autoMode: boolean; reporterId: string | null },
  _planMd: string,
) {
  const token = crypto.randomUUID();

  await prisma.job.update({
    where: { id: job.id },
    data: { planEditToken: token },
  });

  // Get current revision number
  const lastRev = await prisma.planRevision.findFirst({
    where: { jobId: job.id },
    orderBy: { revisionNumber: "desc" },
  });
  const revNumber = lastRev?.revisionNumber ?? 0;
  const revSuffix = revNumber > 0 ? ` (v${revNumber})` : "";

  const botUrl = (process.env.BOT_URL || "http://localhost:3000").replace(/\/+$/, "");
  const planUrl = `${botUrl}/plan-viewer/?jobId=${job.id}&token=${token}`;
  const embed = new EmbedBuilder()
    .setTitle(`📋 Planning Complete${revSuffix}`)
    .setDescription(
      `📝 [Open and edit the plan](${planUrl})\n` +
      `After editing, submit the updated plan using the link above, or use the buttons below.`
    )
    .setColor(0x5865f2);

  const ch = await discordFetch(job.threadId);
  if (!ch) {
    return { success: false, error: "Thread not found" };
  }
  if (!ch.isThread()) {
    botWarn(`Channel ${job.threadId} is not a thread`);
    return { success: false, error: "Channel is not a thread" };
  }

  if (job.autoMode) {
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`cancel:${job.id}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    if (job.reporterId) {
      await ch.send({ content: `<@${job.reporterId}>` });
    }
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

  const historyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`history:${job.id}`)
      .setLabel("View history")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📜"),
  );

  if (job.reporterId) {
    await ch.send({ content: `<@${job.reporterId}>` });
  }
  await ch.send({ embeds: [embed], components: [row, historyRow] });

  return { success: true };
}

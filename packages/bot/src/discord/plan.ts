import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { prisma } from "../db";
import { getClient } from './helpers';
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

  const botUrl = (process.env.BOT_URL || "http://localhost:3000").replace(/\/+$/, "");
  const planUrl = `${botUrl}/plan-viewer/?jobId=${job.id}&token=${token}`;
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

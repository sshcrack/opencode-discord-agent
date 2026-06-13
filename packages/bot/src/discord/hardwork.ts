import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { prisma } from "../db";
import { discordFetch } from "./helpers";
import { postPlan } from "./plan";

interface PlanEntry {
  index: number;
  planMd: string;
  label: string;
}

export async function postHardworkPlans(
  job: { id: number; threadId: string; autoMode: boolean; reporterId: string | null },
  plans: PlanEntry[],
  _synthesizedPlanMd: string,
) {
  const ch = await discordFetch(job.threadId);
  if (!ch?.isThread()) return;

  const embed = new EmbedBuilder()
    .setTitle("🤖 Hardwork Planning Complete")
    .setDescription(`**${plans.length} plans generated!** Choose one below.`)
    .setColor(0x5865f2);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`select_plan:${job.id}`)
    .setPlaceholder("Select a plan to preview...")
    .addOptions(
      ...plans.map(p => {
        const preview = p.planMd.replace(/^#+\s*/gm, "").trim().split("\n").slice(0, 3).join(" ").slice(0, 100);
        return new StringSelectMenuOptionBuilder()
          .setLabel(p.label)
          .setDescription(preview || "Plan preview")
          .setValue(String(p.index));
      }),
    );

  const cancelBtn = new ButtonBuilder()
    .setCustomId(`cancel:hw:${job.id}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  if (job.reporterId) {
    await ch.send({ content: `<@${job.reporterId}>` });
  }
  await ch.send({ embeds: [embed], components: [row, new ActionRowBuilder<ButtonBuilder>().addComponents(cancelBtn)] });
}

export async function handleHardworkPlanSelect(
  interaction: StringSelectMenuInteraction,
  jobId: number,
  planIndex: number,
) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || !job.hardworkPlans) {
    await interaction.reply({ content: ":x: Job or plans not found", ephemeral: true });
    return;
  }

  let plans: PlanEntry[] = [];
  try {
    plans = JSON.parse(job.hardworkPlans);
  } catch {
    await interaction.reply({ content: ":x: Failed to parse plans", ephemeral: true });
    return;
  }

  const selected = plans.find(p => p.index === planIndex);
  if (!selected) {
    await interaction.reply({ content: ":x: Plan not found", ephemeral: true });
    return;
  }

  const preview = selected.planMd.slice(0, 1500);
  const embed = new EmbedBuilder()
    .setTitle(`📋 ${selected.label}`)
    .setDescription(preview || "(empty plan)")
    .setColor(0x5865f2);

  const confirmBtn = new ButtonBuilder()
    .setCustomId(`confirm_plan:${jobId}:${planIndex}`)
    .setLabel("Confirm selection")
    .setStyle(ButtonStyle.Success);

  const goBackBtn = new ButtonBuilder()
    .setCustomId(`go_back_plans:${jobId}`)
    .setLabel("Go back")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, goBackBtn);

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: false,
  });
}

export async function handleHardworkPlanConfirm(
  interaction: ButtonInteraction,
  jobId: number,
  planIndex: number,
) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job || !job.hardworkPlans) {
    await interaction.reply({ content: ":x: Job or plans not found", ephemeral: true });
    return;
  }

  let plans: PlanEntry[] = [];
  try {
    plans = JSON.parse(job.hardworkPlans);
  } catch {
    await interaction.reply({ content: ":x: Failed to parse plans", ephemeral: true });
    return;
  }

  const selected = plans.find(p => p.index === planIndex);
  if (!selected) {
    await interaction.reply({ content: ":x: Selected plan not found", ephemeral: true });
    return;
  }

  await prisma.job.update({
    where: { id: jobId },
    data: {
      selectedPlanIndex: planIndex,
      planMd: selected.planMd,
    },
  });

  await interaction.update({ content: `✅ Plan confirmed: **${selected.label}**`, components: [], embeds: [] });

  await postPlan(
    { id: job.id, threadId: job.threadId, autoMode: false, reporterId: job.reporterId },
    selected.planMd,
  );
}

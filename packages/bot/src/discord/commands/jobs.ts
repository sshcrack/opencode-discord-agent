import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";

const STATUS_EMOJI: Record<string, string> = {
  pending: "\u23f3",
  claimed: "\ud83d\udd04",
  planning: "\ud83d\udcdd",
  plan_ready: "\ud83d\udccb",
  approved: "\u2705",
  building: "\ud83d\udd28",
  done: "\u2705",
  failed: "\u274c",
  cancelled: "\ud83d\udeab",
};

const VALID_STATUSES = ["pending", "claimed", "planning", "plan_ready", "approved", "building", "done", "failed", "cancelled"] as const;

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString();
}

export class JobsCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("jobs")
    .setDescription("List recent jobs with optional filters")
    .addStringOption(o =>
      o.setName("repo").setDescription("Filter by repository slug").setRequired(false).setAutocomplete(true),
    )
    .addStringOption(o =>
      o.setName("status").setDescription("Filter by job status").setRequired(false)
        .addChoices(
          ...VALID_STATUSES.map(s => ({ name: s, value: s })),
        ),
    )
    .addIntegerOption(o =>
      o.setName("limit").setDescription("Number of jobs to show (1-25)").setRequired(false)
        .setMinValue(1).setMaxValue(25),
    );

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;

    const repoSlug = interaction.options.getString("repo");
    const status = interaction.options.getString("status");
    const limit = interaction.options.getInteger("limit") ?? 10;

    const where: Record<string, unknown> = {};
    if (repoSlug) where.repoSlug = repoSlug;
    if (status) where.status = status;

    const jobs = await prisma.job.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    if (jobs.length === 0) {
      const parts: string[] = [];
      if (repoSlug) parts.push(`repo=\`${repoSlug}\``);
      if (status) parts.push(`status=\`${status}\``);
      const filterDesc = parts.length > 0 ? ` matching ${parts.join(", ")}` : "";
      await interaction.reply(`No jobs found${filterDesc}.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Recent Jobs (last ${jobs.length})`);

    if (repoSlug) embed.setDescription(`Filter: repo=\`${repoSlug}\``);

    for (const job of jobs) {
      const emoji = STATUS_EMOJI[job.status] ?? "\u2753";
      const time = relativeTime(job.createdAt);
      const lines: string[] = [
        `${emoji} **${job.status}** \u00b7 ${job.repoSlug} \u00b7 ${job.kind}`,
        `\u200b \u2000 ${time}`,
      ];
      if (job.prUrl) {
        lines.push(`\u200b \u2000 PR: ${job.prUrl}`);
      }
      if (job.issueNumber) {
        lines.push(`\u200b \u2000 Issue: #${job.issueNumber}`);
      }
      embed.addFields({ name: `Job #${job.id}`, value: lines.join("\n"), inline: false });
    }

    await interaction.reply({ embeds: [embed] });
  }
}

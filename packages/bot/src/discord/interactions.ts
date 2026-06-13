import crypto from "node:crypto";
import {
  AutocompleteInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  Message,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { prisma } from "../db";
import type { Job } from "../db/generated/client";
import { botLog, botError } from "../logging";
import { closeThreadForJob, parsePrUrl, postToThread } from "./helpers";
import { handleHardworkPlanSelect, handleHardworkPlanConfirm } from "./hardwork";
import { postPlan } from "./plan";


export async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused();
  const focused = typeof focusedValue === "string" ? focusedValue.toLowerCase() : String(focusedValue);
  botLog("[handleAutocomplete] focused:", focused);

  const repos = await prisma.repository.findMany({
    where: { slug: { contains: focused } },
    take: 25,
  });
  botLog("[handleAutocomplete] found", repos.length, "repos");

  // Filter case-insensitively in JS since SQLite doesn't support mode:"insensitive"
  const filtered = repos.filter(r => r.slug.toLowerCase().includes(focused));

  await interaction.respond(
    filtered.map(r => ({ name: `${r.slug}${r.isDefault ? " (default)" : ""} — ${r.path}`, value: r.slug })),
  );
}

export async function handleButton(interaction: ButtonInteraction) {
  if (!interaction.channel || !interaction.channel.isThread()) {
    return;
  }

  botLog("[handleButton] customId:", interaction.customId, "user:", interaction.user.tag);
  const parts = interaction.customId.split(":");
  const action = parts[0];
  const jobIdStr = parts[1];
  if (!action || !jobIdStr) {
    await interaction.reply({ content: ":x: Invalid custom ID", ephemeral: true });
    return;
  }

  // cancel:hw:{jobId} has a non-numeric second segment, handle before jobId parse
  if (action === "cancel" && jobIdStr === "hw") {
    const jobIdHw = parseInt(parts[2]!);
    if (isNaN(jobIdHw)) {
      await interaction.reply({ content: ":x: Invalid job ID", ephemeral: true });
      return;
    }
    const result = await prisma.job.updateMany({
      where: { id: jobIdHw, status: { in: ["plan_ready", "planning"] } },
      data: { status: "cancelled" },
    });
    await interaction.update({
      content: result.count > 0 ? "❌ Job cancelled" : ":x: Job is no longer in a cancellable state",
      components: [],
      embeds: [],
    });
    return;
  }

  const jobId = parseInt(jobIdStr);
  if (isNaN(jobId)) {
    await interaction.reply({ content: ":x: Invalid job ID", ephemeral: true });
    return;
  }

  if (action === "approve") {
    const result = await prisma.job.updateMany({
      where: { id: jobId, status: "plan_ready" },
      data: { status: "approved" },
    });
    if (result.count === 0) {
      await interaction.update({
        content: ":x: Job is no longer in a state that can be approved (may have been cancelled or auto-approved)",
        components: [],
        embeds: [],
      });
      return;
    }
    await interaction.update({
      content: "✅ Plan approved! Proceeding to build...",
      components: [],
      embeds: [],
    });
  } else if (action === "cancel") {
    const result = await prisma.job.updateMany({
      where: { id: jobId, status: { in: ["plan_ready", "planning"] } },
      data: { status: "cancelled" },
    });
    await interaction.update({
      content: result.count > 0 ? "❌ Job cancelled" : ":x: Job is no longer in a cancellable state",
      components: [],
      embeds: [],
    });
  } else if (action === "suggest") {
    // Acknowledge immediately; do NOT destroy the original plan embed yet —
    // we only clear it after a suggestion is actually received.
    await interaction.reply({
      content: "✏️ Please reply in this thread with your suggestion for the plan revision.",
      ephemeral: true,
    });

    const filter = (m: Message) => !m.author.bot && m.author.id === interaction.user.id;
    const collector = interaction.channel.createMessageCollector({
      filter,
      time: 300_000,
      max: 1,
    });

    collector.on("collect", async (msg) => {
      const suggestion = msg.content.trim();

      await prisma.job.update({
        where: { id: jobId },
        data: { status: "planning", pendingSuggestion: suggestion },
      });

      // Now clear the original plan message components to prevent double-clicks
      await interaction.editReply({ content: `🔄 Forwarding suggestion to worker: "${suggestion}"` }).catch(() => {});
    });

    collector.on("end", collected => {
      if (collected.size === 0) {
        interaction
          .editReply({ content: "⏰ No suggestion received within 5 minutes." })
          .catch(() => {});
      }
    });
  } else if (action === "review_merge") {
    const parentJob = await prisma.job.findUnique({ where: { id: jobId } });
    if (!parentJob || !parentJob.prUrl) {
      await interaction.reply({ content: ":x: This job has no PR to review", ephemeral: true });
      return;
    }

    const activeStatuses: Job["status"][] = ["pending", "claimed", "planning", "plan_ready", "approved", "building"];
    const existingActive = await prisma.job.findFirst({
      where: { threadId: parentJob.threadId, status: { in: activeStatuses } },
    });
    if (existingActive) {
      await interaction.reply({ content: ":x: There's already an active job in this thread", ephemeral: true });
      return;
    }

    await prisma.job.create({
      data: {
        threadId: parentJob.threadId,
        repoSlug: parentJob.repoSlug,
        kind: "other",
        status: "pending",
        context: "review-merge",
        reporterId: interaction.user.id,
        autoMode: true,
        quickMode: true,
        parentJobId: jobId,
      },
    });

    await interaction.update({
      content: "✅ Review & Merge job created! Waiting for worker...",
      components: [],
    });
  } else if (action === "merge_now") {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job || !job.prUrl) {
      await interaction.reply({ content: ":x: This job has no PR to merge", ephemeral: true });
      return;
    }

    const parsed = parsePrUrl(job.prUrl);
    if (!parsed) {
      await interaction.reply({ content: ":x: Could not parse PR URL", ephemeral: true });
      return;
    }

    await interaction.reply({ content: "🚀 Merging PR now...", ephemeral: true });

    const repoArg = `${parsed.owner}/${parsed.repo}`;
    try {
      const ghProc = Bun.spawn([
        "gh", "pr", "merge", String(parsed.prNumber),
        "--repo", repoArg,
        "--squash",
      ], { stdout: "pipe", stderr: "pipe" });
      const errorOutput = await new Response(ghProc.stderr).text();
      const exitCode = await ghProc.exited;

      if (exitCode === 0) {
        await postToThread(job.threadId, `✅ PR merged by <@${interaction.user.id}>`);
        await closeThreadForJob({ id: job.id, threadId: job.threadId });
        await interaction.editReply({ content: "✅ PR merged successfully!" });
      } else {
        botError(`[Merge now] Failed to merge PR ${job.prUrl}: ${errorOutput.trim()}`);
        await postToThread(job.threadId, `❌ Failed to merge PR: ${errorOutput.trim() || "Unknown error"}`);
        await interaction.editReply({ content: `❌ Failed to merge: ${errorOutput.trim() || "Unknown error"}` });
      }
    } catch (err) {
      botError(`[Merge now] Error merging PR for job #${jobId}:`, err);
      await interaction.editReply({ content: `❌ Error merging PR: ${err}` });
    }
  } else if (action === "confirm_plan") {
    const jobIdVal = parseInt(parts[1]!);
    const planIndex = parseInt(parts[2]!);
    if (isNaN(jobIdVal) || isNaN(planIndex)) {
      await interaction.reply({ content: ":x: Invalid custom ID", ephemeral: true });
      return;
    }
    await handleHardworkPlanConfirm(interaction, jobIdVal, planIndex);
  } else if (action === "go_back_plans") {
    await interaction.update({ content: "↩ Select a plan from the dropdown above", components: [], embeds: [] });
  } else if (action === "history") {
    await handleHistoryButton(interaction, jobId);
  } else if (action === "restore_revision") {
    const revNum = parseInt(parts[2]!);
    if (isNaN(revNum)) {
      await interaction.reply({ content: ":x: Invalid revision number", ephemeral: true });
      return;
    }
    await handleRestoreRevision(interaction, jobId, revNum);
  } else if (action === "back_current") {
    await handleBackToCurrent(interaction, jobId);
  }
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction) {
  if (!interaction.channel || !interaction.channel.isThread()) return;

  botLog("[handleSelectMenu] customId:", interaction.customId, "user:", interaction.user.tag);
  const parts = interaction.customId.split(":");
  const action = parts[0];
  const jobIdStr = parts[1];

  if (action === "select_plan" && jobIdStr) {
    const jobId = parseInt(jobIdStr);
    if (isNaN(jobId)) {
      await interaction.reply({ content: ":x: Invalid job ID", ephemeral: true });
      return;
    }
    const planIndex = parseInt(interaction.values[0]!);
    if (isNaN(planIndex)) {
      await interaction.reply({ content: ":x: Invalid plan index", ephemeral: true });
      return;
    }
    await handleHardworkPlanSelect(interaction, jobId, planIndex);
  } else if (action === "select_revision" && jobIdStr) {
    const jobId = parseInt(jobIdStr);
    if (isNaN(jobId)) {
      await interaction.reply({ content: ":x: Invalid job ID", ephemeral: true });
      return;
    }
    const revNum = parseInt(interaction.values[0]!);
    if (isNaN(revNum)) {
      await interaction.reply({ content: ":x: Invalid revision number", ephemeral: true });
      return;
    }
    await handleRevisionSelected(interaction, jobId, revNum);
  }
}

async function handleHistoryButton(interaction: ButtonInteraction, jobId: number) {
  const revisions = await prisma.planRevision.findMany({
    where: { jobId },
    orderBy: { revisionNumber: "desc" },
  });

  if (revisions.length === 0) {
    await interaction.reply({ content: "No revisions found for this job.", ephemeral: true });
    return;
  }

  const options = revisions.map((rev) => {
    const timeAgo = formatTimeAgo(rev.createdAt);
    const label = `v${rev.revisionNumber} — ${rev.source} (${timeAgo})`.slice(0, 100);
    const description = rev.planMd.replace(/#/g, "").trim().slice(0, 90) || "No preview available";
    return {
      label,
      value: String(rev.revisionNumber),
      description,
    };
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`select_revision:${jobId}`)
    .setPlaceholder("Select a revision to view...")
    .addOptions(options.slice(0, 25)); // Discord max 25 options per select

  const cancelRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  // If the interaction hasn't been replied to yet, reply; otherwise update
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content: "📜 **Revision History** — Select a revision to preview:", components: [cancelRow] });
  } else {
    await interaction.update({ content: "📜 **Revision History** — Select a revision to preview:", components: [cancelRow], embeds: [] });
  }
}

async function handleRevisionSelected(interaction: StringSelectMenuInteraction, jobId: number, revNum: number) {
  const revision = await prisma.planRevision.findUnique({
    where: { jobId_revisionNumber: { jobId, revisionNumber: revNum } },
  });
  if (!revision) {
    await interaction.update({ content: ":x: Revision not found", components: [], embeds: [] });
    return;
  }

  const timeAgo = formatTimeAgo(revision.createdAt);
  const preview = revision.planMd.slice(0, 1500) + (revision.planMd.length > 1500 ? "\n\n*... (truncated)*" : "");

  const embed = new EmbedBuilder()
    .setTitle(`📜 Revision v${revision.revisionNumber}`)
    .setDescription(preview)
    .addFields(
      { name: "Source", value: revision.source, inline: true },
      { name: "Created", value: timeAgo, inline: true },
    )
    .setColor(0x5865f2);

  const restoreButton = new ButtonBuilder()
    .setCustomId(`restore_revision:${jobId}:${revNum}`)
    .setLabel(`Restore v${revNum}`)
    .setStyle(ButtonStyle.Primary);

  const backButton = new ButtonBuilder()
    .setCustomId(`back_current:${jobId}`)
    .setLabel("Back to current")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(restoreButton, backButton);

  await interaction.update({ embeds: [embed], components: [row] });
}

async function handleRestoreRevision(interaction: ButtonInteraction, jobId: number, revNum: number) {
  const revision = await prisma.planRevision.findUnique({
    where: { jobId_revisionNumber: { jobId, revisionNumber: revNum } },
  });
  if (!revision) {
    await interaction.update({ content: ":x: Revision not found", components: [], embeds: [] });
    return;
  }

  const token = crypto.randomUUID();

  // Update job planMd and token
  await prisma.job.update({
    where: { id: jobId },
    data: {
      planMd: revision.planMd,
      planEditToken: token,
    },
  });

  // Save a restore revision entry
  const lastRev = await prisma.planRevision.findFirst({
    where: { jobId },
    orderBy: { revisionNumber: "desc" },
  });
  await prisma.planRevision.create({
    data: {
      jobId,
      revisionNumber: (lastRev?.revisionNumber ?? 0) + 1,
      planMd: revision.planMd,
      source: "restored",
    },
  }).catch(() => {});

  await interaction.update({
    content: `✅ Restored to revision v${revNum} from ${formatTimeAgo(revision.createdAt)}! The plan viewer now shows this version.`,
    components: [],
    embeds: [],
  });
}

async function handleBackToCurrent(interaction: ButtonInteraction, jobId: number) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) {
    await interaction.update({ content: ":x: Job not found", components: [], embeds: [] });
    return;
  }

  // Re-post the original plan embed by calling postPlan
  await postPlan(
    { id: job.id, threadId: job.threadId, autoMode: job.autoMode, reporterId: job.reporterId },
    job.planMd ?? "",
  );

  await interaction.update({
    content: "↩ Returned to the current plan.",
    components: [],
    embeds: [],
  });
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

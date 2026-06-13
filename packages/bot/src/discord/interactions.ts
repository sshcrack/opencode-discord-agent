import { AutocompleteInteraction, ButtonInteraction, StringSelectMenuInteraction, Message } from "discord.js";
import { prisma } from "../db";
import type { Job } from "../db/generated/client";
import { botLog, botError } from "../logging";
import { closeThreadForJob, parsePrUrl, postToThread } from "./helpers";
import { handleHardworkPlanSelect, handleHardworkPlanConfirm } from "./hardwork";


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
  }
}

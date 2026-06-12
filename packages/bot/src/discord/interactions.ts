import { AutocompleteInteraction, ButtonInteraction, Message } from "discord.js";
import { prisma } from "../db";
import type { Job } from "../db/generated/client";
import { botLog } from "../logging";


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
    await interaction.update({
      content: "✏️ Please reply in this thread with your suggestion for the plan revision.",
      components: [],
      embeds: [],
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

      await interaction.followUp(
        `🔄 Forwarding suggestion to worker: "${suggestion}"`,
      );
    });

    collector.on("end", collected => {
      if (collected.size === 0) {
        interaction
          .followUp({ content: "⏰ No suggestion received within 5 minutes.", ephemeral: true })
          .catch(() => { });
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
  }
}

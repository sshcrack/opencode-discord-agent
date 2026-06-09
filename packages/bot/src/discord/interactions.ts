import { AutocompleteInteraction, ButtonInteraction, Message, Collection } from "discord.js";
import { prisma } from "../db";

export async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toString().toLowerCase();
  const repos = await prisma.repository.findMany({
    where: { slug: { contains: focused } },
    take: 25,
  });

  await interaction.respond(
    repos.map(r => ({ name: `${r.slug}${r.isDefault ? " (default)" : ""} — ${r.path}`, value: r.slug })),
  );
}

export async function handleButton(interaction: ButtonInteraction) {
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
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "approved" },
    });
    await interaction.update({
      content: "✅ Plan approved! Proceeding to build...",
      components: [],
      embeds: [],
    });
  } else if (action === "cancel") {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (job && (job.status === "plan_ready" || job.status === "planning")) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "cancelled" },
      });
    }
    await interaction.update({ content: "❌ Job cancelled", components: [], embeds: [] });
  } else if (action === "suggest") {
    await interaction.update({
      content: "✏️ Please reply in this thread with your suggestion for the plan revision.",
      components: [],
      embeds: [],
    });

    const filter = (m: any) => !m.author.bot && m.author.id === interaction.user.id;
    const collector = (interaction.channel as any).createMessageCollector({
      filter,
      time: 300_000,
      max: 1,
    });

    collector.on("collect", async (msg: any) => {
      const suggestion = msg.content.trim();

      await prisma.job.update({
        where: { id: jobId },
        data: { status: "planning", pendingSuggestion: suggestion },
      });

      await interaction.followUp(
        `🔄 Forwarding suggestion to worker: "${suggestion}"`,
      );
    });

    collector.on("end", (collected: any) => {
      if (collected.size === 0) {
        interaction
          .followUp({ content: "⏰ No suggestion received within 5 minutes.", ephemeral: true })
          .catch(() => {});
      }
    });
  }
}

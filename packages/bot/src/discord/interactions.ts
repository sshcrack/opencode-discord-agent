import { AutocompleteInteraction, ButtonInteraction } from "discord.js";
import { prisma } from "../db";
import { postToThread } from "./helpers";

export async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toString().toLowerCase();
  const repos = await prisma.repository.findMany({
    where: { slug: { contains: focused } },
    take: 25,
  });

  await interaction.respond(
    repos.map(r => ({ name: `${r.slug} (${r.path})`, value: r.slug })),
  );
}

export async function handleButton(interaction: ButtonInteraction) {
  const [action, jobIdStr] = interaction.customId.split(":");
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
      content: ":white_check_mark: Plan approved! Proceeding to build...",
      components: [],
      embeds: [],
    });
  } else if (action === "cancel") {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (job && job.status === "plan_ready") {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "cancelled" },
      });
    }
    await interaction.update({ content: ":x: Job cancelled", components: [], embeds: [] });
  } else if (action === "suggest") {
    await interaction.update({
      content: ":pencil: Please reply in this thread with your suggestion for the plan revision.",
      components: [],
      embeds: [],
    });

    const filter = (m: any) => m.author.id === interaction.user.id;
    const collector = (interaction.channel as any).createMessageCollector({
      filter,
      time: 300_000,
      max: 1,
    });

    collector.on("collect", async (msg: any) => {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: "planning" },
      });
      await interaction.followUp(
        `:arrows_counterclockwise: Forwarding suggestion to worker: "${msg.content}"`,
      );
    });

    collector.on("end", (collected: any) => {
      if (collected.size === 0) {
        interaction.followUp({ content: ":x: No suggestion received", ephemeral: true });
      }
    });
  }
}

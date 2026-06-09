import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { prisma } from "../db";
import { ThreadStatus } from "@discord-agent/shared";

export const data = new SlashCommandBuilder()
  .setName("create-report")
  .setDescription("Create a new bug/feature report thread")
  .addStringOption((opt) =>
    opt
      .setName("kind")
      .setDescription("Type of report")
      .setRequired(true)
      .addChoices(
        { name: "Bug", value: "BUG" },
        { name: "Feature", value: "FEATURE" },
        { name: "Other", value: "OTHER" },
      ),
  )
  .addStringOption((opt) =>
    opt
      .setName("repo")
      .setDescription("Registered repository name (default: first registered)")
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const kind = interaction.options.getString("kind", true);
  let repo = interaction.options.getString("repo");

  if (!repo) {
    const first = await prisma.repository.findFirst({ orderBy: { name: "asc" } });
    if (!first) {
      await interaction.reply({
        content: "No repositories registered. Admin must run `/add-repository` first.",
        ephemeral: true,
      });
      return;
    }
    repo = first.name;
  } else {
    const exists = await prisma.repository.findUnique({ where: { name: repo } });
    if (!exists) {
      await interaction.reply({
        content: `Repository **${repo}** not found. Use \`/list-repositories\` to see available ones.`,
        ephemeral: true,
      });
      return;
    }
  }

  if (!interaction.channel || !interaction.channel.isTextBased()) {
    await interaction.reply({
      content: "This command can only be used in a text channel.",
      ephemeral: true,
    });
    return;
  }

  if (!("threads" in interaction.channel)) {
    await interaction.reply({
      content: "This channel does not support threads.",
      ephemeral: true,
    });
    return;
  }

  const thread = await (interaction.channel as any).threads.create({
    name: `[${kind.toLowerCase()}] ${Date.now()}`,
    type: 12,
    reason: `New ${kind} report`,
  });

  if (!thread) {
    await interaction.reply({
      content: "Failed to create thread.",
      ephemeral: true,
    });
    return;
  }

  await prisma.thread.create({
    data: {
      id: thread.id,
      repo,
      kind,
      status: ThreadStatus.COLLECTING,
    },
  });

  await interaction.reply({
    content: `Thread ready for **${repo}** — add context, upload files, then run \`/submit\`.`,
  });
}

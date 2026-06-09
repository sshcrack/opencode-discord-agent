import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { prisma } from "../db";
import { statSync } from "node:fs";

export const data = new SlashCommandBuilder()
  .setName("add-repository")
  .setDescription("Register a local directory for the agent to work on")
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("Short name to reference in /create-report")
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("path")
      .setDescription("Absolute path to the local directory")
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString("name", true);
  const path = interaction.options.getString("path", true);

  try {
    statSync(path);
  } catch {
    await interaction.reply({
      content: `❌ Path does not exist: \`${path}\``,
      ephemeral: true,
    });
    return;
  }

  await prisma.repository.upsert({
    where: { name },
    create: { name, path },
    update: { path },
  });

  await interaction.reply({
    content: `✅ Repository **${name}** → \`${path}\``,
  });
}

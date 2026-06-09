import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { prisma } from "../db";

export const data = new SlashCommandBuilder()
  .setName("remove-repository")
  .setDescription("Remove a registered repository")
  .addStringOption((opt) =>
    opt
      .setName("name")
      .setDescription("Name of the repository to remove")
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString("name", true);

  try {
    await prisma.repository.delete({ where: { name } });
    await interaction.reply({
      content: `✅ Removed repository **${name}**`,
    });
  } catch {
    await interaction.reply({
      content: `❌ Repository **${name}** not found.`,
      ephemeral: true,
    });
  }
}

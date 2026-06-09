import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { prisma } from "../db";

export const data = new SlashCommandBuilder()
  .setName("list-repositories")
  .setDescription("List all registered local directories");

export async function execute(interaction: ChatInputCommandInteraction) {
  const repos = await prisma.repository.findMany({ orderBy: { name: "asc" } });

  if (repos.length === 0) {
    await interaction.reply({
      content: "No repositories registered. Use `/add-repository` to add one.",
      ephemeral: true,
    });
    return;
  }

  const lines = repos.map((r) => `• **${r.name}** — \`${r.path}\``);
  await interaction.reply({
    content: `**Registered repositories:**\n${lines.join("\n")}`,
  });
}

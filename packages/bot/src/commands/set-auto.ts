import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { prisma } from "../db";

export const data = new SlashCommandBuilder()
  .setName("set-auto")
  .setDescription("Set the global auto-mode default")
  .addStringOption((opt) =>
    opt
      .setName("mode")
      .setDescription("Auto-approve plans?")
      .setRequired(true)
      .addChoices(
        { name: "On", value: "on" },
        { name: "Off", value: "off" },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const mode = interaction.options.getString("mode", true);
  const value = mode === "on" ? "true" : "false";

  await prisma.setting.upsert({
    where: { key: "auto_mode" },
    create: { key: "auto_mode", value },
    update: { value },
  });

  await interaction.reply({
    content: `Global auto-mode set to **${mode}**.\nRun \`/submit --auto:true\` to override per-job.`,
  });
}

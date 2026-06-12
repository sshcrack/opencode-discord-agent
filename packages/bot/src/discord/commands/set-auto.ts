import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";

export class SetAutoCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("set-auto")
    .setDescription("Set the global default for auto-mode")
    .addStringOption(o =>
      o
        .setName("mode")
        .setDescription("Auto mode")
        .setRequired(true)
        .addChoices(
          { name: "On", value: "on" },
          { name: "Off", value: "off" },
        ),
    );

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    const mode = interaction.options.getString("mode", true);

    await prisma.setting.upsert({
      where: { key: "auto_mode" },
      update: { value: mode },
      create: { key: "auto_mode", value: mode },
    });

    await interaction.reply(`:white_check_mark: Auto-mode set to **${mode}**`);
  }
}

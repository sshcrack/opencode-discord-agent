import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";

export class SetQuickCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("set-quick")
    .setDescription("Set the global default for quick-mode")
    .addStringOption(o =>
      o.setName("mode")
        .setDescription("Quick mode")
        .setRequired(true)
        .addChoices(
          { name: "On", value: "on" },
          { name: "Off", value: "off" },
        ),
    ) as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    const mode = interaction.options.getString("mode", true);
    await prisma.setting.upsert({
      where: { key: "quick_mode" },
      update: { value: mode },
      create: { key: "quick_mode", value: mode },
    });
    await interaction.reply(`:white_check_mark: Quick-mode set to **${mode}**`);
  }
}

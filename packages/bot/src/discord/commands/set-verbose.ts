import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";

export class SetVerboseCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("set-verbose")
    .setDescription("Toggle verbose status reporting in threads")
    .addStringOption(o =>
      o
        .setName("mode")
        .setDescription("Verbose mode")
        .setRequired(true)
        .addChoices(
          { name: "On (all steps)", value: "on" },
          { name: "Off (success/error only)", value: "off" },
        ),
    ) as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    const mode = interaction.options.getString("mode", true);

    await prisma.setting.upsert({
      where: { key: "verbose_mode" },
      update: { value: mode },
      create: { key: "verbose_mode", value: mode },
    });

    await interaction.reply(
      `:white_check_mark: Verbose mode set to **${mode}** — ${
        mode === "on"
          ? "all agent steps will be posted to threads"
          : "only success/error messages will be posted"
      }`,
    );
  }
}

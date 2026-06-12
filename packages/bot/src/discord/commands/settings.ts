import { SlashCommandBuilder, SlashCommandSubcommandBuilder, CommandInteraction, EmbedBuilder } from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";

const KNOWN_SETTINGS: { key: string; label: string; defaultValue: string }[] = [
  { key: "auto_mode", label: "Auto mode", defaultValue: "off" },
  { key: "quick_mode", label: "Quick mode", defaultValue: "off" },
  { key: "verbose_mode", label: "Verbose mode", defaultValue: "on" },
  { key: "issue_model", label: "Issue model", defaultValue: "opencode/big-pickle" },
  { key: "fallback_model", label: "Fallback model", defaultValue: "opencode/big-pickle" },
];

export class SettingsCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("settings")
    .setDescription("View or change bot settings")
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("view")
        .setDescription("Show all current settings"),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("model")
        .setDescription("Set the issue generation model")
        .addStringOption(o =>
          o.setName("value").setDescription("Model name (e.g. opencode/big-pickle)").setRequired(true),
        ),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("fallback-model")
        .setDescription("Set the fallback model")
        .addStringOption(o =>
          o.setName("value").setDescription("Model name (e.g. opencode/big-pickle)").setRequired(true),
        ),
    );

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "view") {
      const dbSettings = await prisma.setting.findMany();
      const settingMap = new Map(dbSettings.map(s => [s.key, s.value]));

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("Bot Settings");

      for (const known of KNOWN_SETTINGS) {
        const value = settingMap.get(known.key) ?? known.defaultValue;
        const isDefault = !settingMap.has(known.key);
        embed.addFields({
          name: known.label,
          value: `\`${value}\`${isDefault ? " *(default)*" : ""}`,
          inline: true,
        });
      }

      embed.setFooter({ text: "Use /settings model <name> or /settings fallback-model <name> to change" });

      await interaction.reply({ embeds: [embed] });
    } else if (subcommand === "model") {
      const value = interaction.options.getString("value", true);

      await prisma.setting.upsert({
        where: { key: "issue_model" },
        update: { value },
        create: { key: "issue_model", value },
      });

      await interaction.reply(`:white_check_mark: Issue generation model set to \`${value}\``);
    } else if (subcommand === "fallback-model") {
      const value = interaction.options.getString("value", true);

      await prisma.setting.upsert({
        where: { key: "fallback_model" },
        update: { value },
        create: { key: "fallback_model", value },
      });

      await interaction.reply(`:white_check_mark: Fallback model set to \`${value}\``);
    }
  }
}

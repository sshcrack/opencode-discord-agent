import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from "discord.js";
import { Command } from "./Command";

interface CommandInfo {
  name: string;
  description: string;
  options?: string;
}

const categories: { name: string; emoji: string; commands: CommandInfo[] }[] = [
  {
    name: "Repository Management",
    emoji: "\ud83d\udcc1",
    commands: [
      { name: "/repo add <slug> <path> [origin-url]", description: "Register a new repository" },
      { name: "/repo remove <slug>", description: "Remove a repository record" },
      { name: "/repo list", description: "List all registered repositories" },
      { name: "/repo set-default <slug>", description: "Change the default repository" },
      { name: "/repo sync-channels", description: "Create missing Discord channels for repos" },
    ],
  },
  {
    name: "Reports & Jobs",
    emoji: "\ud83d\udccb",
    commands: [
      { name: "/create-report <kind> [repo]", description: "Create a new report thread" },
      { name: "/submit [auto] [quick]", description: "Submit the current thread as a job" },
      { name: "/resolve <issue> [auto] [quick]", description: "Create a fix job from a GitHub issue" },
      { name: "/jobs [repo] [status] [limit]", description: "List recent jobs with filters" },
    ],
  },
  {
    name: "Settings",
    emoji: "\u2699\ufe0f",
    commands: [
      { name: "/settings [model] [fallback-model]", description: "View or change bot settings" },
      { name: "/set-auto <mode>", description: "Set global auto-approve mode" },
      { name: "/set-quick <mode>", description: "Set global quick mode (skip planning)" },
      { name: "/set-verbose <mode>", description: "Toggle verbose status reporting" },
    ],
  },
  {
    name: "Utilities",
    emoji: "\ud83d\udee0\ufe0f",
    commands: [
      { name: "/clear-session", description: "Delete bot messages in the current thread" },
      { name: "/update", description: "Pull latest code and migrate database" },
      { name: "/close", description: "Close and archive the current report thread" },
      { name: "/help", description: "Show this command reference" },
    ],
  },
];

export class HelpCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show a categorized list of all available commands");

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("opencode-discord — Commands")
      .setDescription("All available slash commands grouped by category");

    for (const category of categories) {
      const value = category.commands
        .map(cmd => {
          const opt = cmd.options ? ` ${cmd.options}` : "";
          return `\`/${cmd.name}${opt}\`\n\u200b \u200b ${cmd.description}`;
        })
        .join("\n\n");
      embed.addFields({ name: `${category.emoji} ${category.name}`, value, inline: false });
    }

    embed.setFooter({ text: "Use /help to see this message at any time" });
    embed.setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
}

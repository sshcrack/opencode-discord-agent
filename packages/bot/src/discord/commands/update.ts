import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { Command } from "./Command";

export class UpdateCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("update")
    .setDescription("Pull latest changes and restart the bot") as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply();

    const gitRoot = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim();
    if (!gitRoot) {
      await interaction.editReply("❌ Not a git repository");
      return;
    }

    const pull = Bun.spawnSync(["git", "pull"], { cwd: gitRoot });
    if (pull.exitCode !== 0) {
      await interaction.editReply(`❌ git pull failed: ${pull.stderr.toString().slice(0, 500)}`);
      return;
    }

    const output = pull.stdout.toString().trim();
    await interaction.editReply(`✅ Updated.\n\`\`\`\n${output.slice(0, 1500)}\n\`\`\`\nRestarting...`);

    process.exit(0);
  }
}

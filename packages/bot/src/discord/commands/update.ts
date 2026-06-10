import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { Command } from "./Command";
import { prisma } from "../../db";
import { stopTRPCServer } from "../../trpc/server";

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

    stopTRPCServer();
    await prisma.$disconnect();

    const botDir = `${gitRoot}/packages/bot`;
    const migrate = Bun.spawnSync(["bun", "--bun", "prisma", "migrate", "deploy"], { cwd: botDir });
    const migrateOk = migrate.exitCode === 0;
    const migrateOutput = migrateOk
      ? ""
      : `\n❌ Migration failed: ${migrate.stderr.toString().slice(0, 500)}`;

    if (migrateOk) {
      const generate = Bun.spawnSync(["bunx", "--bun", "prisma", "generate"], { cwd: botDir });
      if (generate.exitCode !== 0) {
        console.error(`prisma generate failed: ${generate.stderr.toString().slice(0, 500)}`);
      }
    }

    // Save the channel so the bot can post "Done." after restart
    await prisma.setting.upsert({
      where: { key: "last_update_channel_id" },
      update: { value: interaction.channelId },
      create: { key: "last_update_channel_id", value: interaction.channelId },
    });

    await interaction.editReply(
      `✅ Updated.\`\`\`\n${output.slice(0, 1500)}\n\`\`\`${migrateOutput}\nRestarting...`,
    );

    process.exit(0);
  }
}

import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { Command } from "./Command";
import { prisma } from "../../db";
import { gracefulShutdown } from "../../trpc/server";

export class UpdateCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("update")
    .setDescription("Pull latest changes and restart bot");

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
    const lines: string[] = [];

    // ── Save reply channel before disconnect ──────────────────────────────
    await prisma.setting.upsert({
      where: { key: "last_update_channel_id" },
      update: { value: interaction.channelId },
      create: { key: "last_update_channel_id", value: interaction.channelId },
    });

    // ── Update bot ────────────────────────────────────────────────────────
    await gracefulShutdown();

    const botDir = `${gitRoot}/packages/bot`;
    const migrate = Bun.spawnSync(["bun", "--bun", "prisma", "migrate", "deploy"], { cwd: botDir });
    const migrateOk = migrate.exitCode === 0;
    if (!migrateOk) {
      lines.push(`❌ Migration failed: ${migrate.stderr.toString().slice(0, 500)}`);
    } else {
      const generate = Bun.spawnSync(["bunx", "--bun", "prisma", "generate"], { cwd: botDir });
      if (generate.exitCode !== 0) {
        console.error(`prisma generate failed: ${generate.stderr.toString().slice(0, 500)}`);
      }
    }

    lines.push("ℹ️ Worker will auto-update on next heartbeat (git HEAD exchange)");

    await interaction.editReply(
      `✅ Updated.\`\`\`\n${output.slice(0, 1500)}\n\`\`\`` +
      (lines.length > 0 ? `\n${lines.join("\n")}` : ""),
    );

    process.exit(0);
  }
}

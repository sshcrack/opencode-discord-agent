import {
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  CommandInteraction,
} from "discord.js";
import { prisma } from "../../db";
import { existsSync } from "fs";
import { Command } from "./Command";

export class RepoCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("repo")
    .setDescription("Manage repositories")
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("add")
        .setDescription("Register a new repository")
        .addStringOption(o => o.setName("slug").setDescription("Human-readable slug").setRequired(true))
        .addStringOption(o => o.setName("path").setDescription("Absolute path on filesystem").setRequired(true)),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("remove")
        .setDescription("Remove a repository record")
        .addStringOption(o =>
          o.setName("slug").setDescription("Repository slug").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("list")
        .setDescription("List all registered repositories"),
    )
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("set-default")
        .setDescription("Set the default repository")
        .addStringOption(o =>
          o.setName("slug").setDescription("Repository slug").setRequired(true).setAutocomplete(true),
        ),
    ) as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    const subcommand = interaction.options.getSubcommand();
    console.log("[RepoCommand] Subcommand:", subcommand);

    if (subcommand === "add") {
      const slug = interaction.options.getString("slug", true);
      const path = interaction.options.getString("path", true);

      if (!existsSync(path)) {
        await interaction.reply({ content: `:x: Path \`${path}\` does not exist`, ephemeral: true });
        return;
      }

      const existing = await prisma.repository.findUnique({ where: { slug } });
      if (existing) {
        await interaction.reply({ content: `:x: Repository \`${slug}\` already exists`, ephemeral: true });
        return;
      }

      const repoCount = await prisma.repository.count();
      const repo = await prisma.repository.create({
        data: { slug, path, isDefault: repoCount === 0 },
      });

      await interaction.reply(`:white_check_mark: Repository \`${slug}\` added${repo.isDefault ? " (set as default)" : ""}`);
    } else if (subcommand === "remove") {
      const slug = interaction.options.getString("slug", true);
      const repo = await prisma.repository.findUnique({ where: { slug } });

      if (!repo) {
        await interaction.reply({ content: `:x: Repository \`${slug}\` not found`, ephemeral: true });
        return;
      }

      // Prevent removing repo with active jobs
      const activeJobs = await prisma.job.count({
        where: { repoSlug: slug, status: { in: ["pending", "claimed", "planning", "plan_ready", "approved", "building"] } },
      });
      if (activeJobs > 0) {
        await interaction.reply({
          content: `:x: Cannot remove \`${slug}\` — there are ${activeJobs} active job(s) associated with it`,
          ephemeral: true,
        });
        return;
      }

      const wasDefault = repo.isDefault;
      const repoCount = await prisma.repository.count();
      if (repoCount <= 1) {
        await interaction.reply({
          content: `:x: Cannot remove the last repository. Add another repository first.`,
          ephemeral: true,
        });
        return;
      }

      await prisma.repository.delete({ where: { slug } });

      if (wasDefault) {
        const first = await prisma.repository.findFirst({ orderBy: { createdAt: "asc" } });
        if (first) {
          await prisma.repository.update({ where: { id: first.id }, data: { isDefault: true } });
        }
      }

      await interaction.reply(`:white_check_mark: Repository \`${slug}\` removed`);
    } else if (subcommand === "list") {
      const repos = await prisma.repository.findMany({ orderBy: { createdAt: "asc" } });

      if (repos.length === 0) {
        await interaction.reply("No repositories registered.");
        return;
      }

      const lines = repos.map(r => `${r.isDefault ? "⭐ " : ""}**${r.slug}** → \`${r.path}\``);
      await interaction.reply(`**Registered repositories:**\n${lines.join("\n")}`);
    } else if (subcommand === "set-default") {
      const slug = interaction.options.getString("slug", true);
      const repo = await prisma.repository.findUnique({ where: { slug } });

      if (!repo) {
        await interaction.reply({ content: `:x: Repository \`${slug}\` not found`, ephemeral: true });
        return;
      }

      await prisma.repository.updateMany({ data: { isDefault: false } });
      await prisma.repository.update({ where: { slug }, data: { isDefault: true } });

      await interaction.reply(`:white_check_mark: Default repository set to \`${slug}\``);
    }
  }
}

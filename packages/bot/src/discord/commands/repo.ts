import {
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
  CommandInteraction,
  ChannelType,
  GuildChannel,
} from "discord.js";
import { prisma } from "../../db";
import { Command } from "./Command";
import { getClient } from "../helpers";

export class RepoCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("repo")
    .setDescription("Manage repositories")
    .addSubcommand(
      new SlashCommandSubcommandBuilder()
        .setName("add")
        .setDescription("Register a new repository")
        .addStringOption(o => o.setName("slug").setDescription("Human-readable slug").setRequired(true))
        .addStringOption(o => o.setName("path").setDescription("Absolute path on filesystem").setRequired(true))
        .addStringOption(o =>
          o.setName("origin-url").setDescription("Git remote URL for cloning (required for fallback)").setRequired(false),
        ),
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
      const originUrl = interaction.options.getString("origin-url") || undefined;

      const existing = await prisma.repository.findUnique({ where: { slug } });
      if (existing) {
        await interaction.reply({ content: `:x: Repository \`${slug}\` already exists`, ephemeral: true });
        return;
      }

      const repoCount = await prisma.repository.count();

      // Create a Discord text channel for the repo
      let channelId: string | null = null;
      if (interaction.guild) {
        try {
          const guild = await getClient().guilds.fetch(interaction.guild.id);
          let parentId: string | null = null;

          if (interaction.channel && "parent" in interaction.channel) {
            const cat = (interaction.channel as any).parent as GuildChannel | null;
            if (cat) parentId = cat.id;
          }

          const created = await guild.channels.create({
            name: slug,
            type: ChannelType.GuildText,
            parent: parentId ?? undefined,
            reason: `Auto-created for repository ${slug}`,
          });
          channelId = created.id;
        } catch (err) {
          console.warn(`[RepoCommand] Failed to create Discord channel for ${slug}:`, err);
        }
      }

      const repo = await prisma.repository.create({
        data: { slug, path, originUrl, channelId, isDefault: repoCount === 0 },
      });

      const parts = [`\`${slug}\` added`];
      if (channelId) parts.push(`channel created: <#${channelId}>`);
      if (repo.isDefault) parts.push("set as default");
      if (!originUrl) parts.push("no origin URL — fallback will be unavailable");
      await interaction.reply(`:white_check_mark: ${parts.join(" — ")}`);
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

      // Delete the Discord channel if it exists
      if (repo.channelId) {
        try {
          const channel = await getClient().channels.fetch(repo.channelId);
          if (channel?.isTextBased() && "delete" in channel) {
            await (channel as any).delete(`Repository ${slug} removed`);
          }
        } catch (err) {
          console.warn(`[RepoCommand] Failed to delete channel ${repo.channelId}:`, err);
        }
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

      const lines = repos.map(r => {
        const channelRef = r.channelId ? ` <#${r.channelId}>` : "";
        return `${r.isDefault ? "⭐ " : ""}**${r.slug}**${channelRef} → \`${r.path}\``;
      });
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

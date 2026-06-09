import { SlashCommandBuilder, CommandInteraction, ChannelType, TextChannel } from "discord.js";
import type { ReportKind } from "../../db/generated/client";
import { prisma } from "../../db";
import { Command } from "./Command";

export class CreateReportCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("create-report")
    .setDescription("Create a new report thread")
    .addStringOption(o =>
      o
        .setName("kind")
        .setDescription("Type of report")
        .setRequired(true)
        .addChoices(
          { name: "Bug", value: "bug" },
          { name: "Feature", value: "feature" },
          { name: "Refactor", value: "refactor" },
          { name: "Other", value: "other" },
        ),
    )
    .addStringOption(o =>
      o
        .setName("repo")
        .setDescription("Repository slug (defaults to default)")
        .setRequired(false)
        .setAutocomplete(true),
    ) as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    const kind = interaction.options.getString("kind", true);
    const repoSlug = interaction.options.getString("repo");
    console.log("[CreateReportCommand] kind:", kind, "repoSlug:", repoSlug);

    let slug = repoSlug;
    if (!slug) {
      const defaultRepo = await prisma.repository.findFirst({ where: { isDefault: true } });
      if (!defaultRepo) {
        await interaction.reply({
          content: ":x: No repositories registered. Add one with `/repo add`",
          ephemeral: true,
        });
        return;
      }
      slug = defaultRepo.slug;
    }

    const repo = await prisma.repository.findUnique({ where: { slug } });
    if (!repo) {
      await interaction.reply({ content: `:x: Repository \`${slug}\` not found`, ephemeral: true });
      return;
    }

    const ts = Date.now().toString(36);
    const threadName = `${kind}-${ts}`;

    const thread = await (interaction.channel as TextChannel).threads.create({
      name: threadName,
      type: ChannelType.PrivateThread,
      reason: `New ${kind} report`,
    });

    await prisma.reportThread.create({
      data: { threadId: thread.id, kind: kind as ReportKind, repoSlug: slug },
    });

    await interaction.reply(`:white_check_mark: Report thread created: ${thread}`);
    await thread.send(
      `Repository: \`${slug}\` | Kind: **${kind}**\nUse \`/submit\` to submit this report as a job.`,
    );
  }
}

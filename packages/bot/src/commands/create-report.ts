import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  ChannelType,
} from "discord.js";
import { prisma } from "../db";
import { ThreadStatus } from "@discord-agent/shared";

export const data = new SlashCommandBuilder()
  .setName("create-report")
  .setDescription("Create a new bug/feature report thread")
  .addStringOption((opt) =>
    opt
      .setName("kind")
      .setDescription("Type of report")
      .setRequired(true)
      .addChoices(
        { name: "Bug", value: "BUG" },
        { name: "Feature", value: "FEATURE" },
        { name: "Other", value: "OTHER" },
      ),
  )
  .addStringOption((opt) =>
    opt
      .setName("repo")
      .setDescription("GitHub repo slug (default: DEFAULT_REPO)")
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const kind = interaction.options.getString("kind", true);
  const repo =
    interaction.options.getString("repo") ||
    process.env.DEFAULT_REPO ||
    "sshcrack/talking-colonists";

  if (!interaction.channel || !interaction.channel.isTextBased()) {
    await interaction.reply({
      content: "This command can only be used in a text channel.",
      ephemeral: true,
    });
    return;
  }

  if (!("threads" in interaction.channel)) {
    await interaction.reply({
      content: "This channel does not support threads.",
      ephemeral: true,
    });
    return;
  }

  const thread = await (interaction.channel as any).threads.create({
    name: `[${kind.toLowerCase()}] ${Date.now()}`,
    type: ChannelType.PrivateThread,
    reason: `New ${kind} report`,
  });

  if (!thread) {
    await interaction.reply({
      content: "Failed to create thread.",
      ephemeral: true,
    });
    return;
  }

  await prisma.thread.create({
    data: {
      id: thread.id,
      repo,
      kind,
      status: ThreadStatus.COLLECTING,
    },
  });

  await interaction.reply({
    content: `Thread ready — add context, upload files, then run \`/submit\`.`,
  });
}

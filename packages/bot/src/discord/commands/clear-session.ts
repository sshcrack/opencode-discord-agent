import { SlashCommandBuilder, CommandInteraction } from "discord.js";
import { Command } from "./Command";

export class ClearSessionCommand extends Command {
  data = new SlashCommandBuilder()
    .setName("clear-session")
    .setDescription("Delete all bot messages in this thread") as SlashCommandBuilder;

  async execute(interaction: CommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply();

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.editReply(":x: This command can only be used inside a thread");
      return;
    }

    const botId = interaction.client.user.id;
    const replyMsg = await interaction.fetchReply();
    const replyId = replyMsg.id;

    const toDelete: import("discord.js").Message[] = [];
    let lastId: string | undefined;

    while (true) {
      const fetched = await thread.messages.fetch({
        limit: 100,
        ...(lastId ? { before: lastId } : {}),
      });
      if (fetched.size === 0) break;

      for (const msg of fetched.values()) {
        if (msg.author.id === botId && msg.id !== replyId) {
          toDelete.push(msg);
        }
      }

      const last = fetched.last();
      if (!last) break;
      lastId = last.id;
      if (fetched.size < 100) break;
    }

    for (let i = 0; i < toDelete.length; i += 10) {
      await Promise.all(toDelete.slice(i, i + 10).map(msg => msg.delete().catch(() => {})));
    }

    await interaction.editReply(`✅ Deleted ${toDelete.length} bot message(s).`);
  }
}

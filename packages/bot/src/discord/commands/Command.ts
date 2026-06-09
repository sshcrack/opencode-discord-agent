import { SlashCommandBuilder, CommandInteraction } from "discord.js";

export abstract class Command {
  abstract data: SlashCommandBuilder;
  abstract execute(interaction: CommandInteraction): Promise<void>;
}

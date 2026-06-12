import { CommandInteraction } from "discord.js";

export abstract class Command {
  abstract data: { readonly name: string; toJSON(): unknown };
  abstract execute(interaction: CommandInteraction): Promise<void>;
}

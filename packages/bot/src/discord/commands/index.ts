import { CommandInteraction } from "discord.js";
import { Command } from "./Command";
import { RepoCommand } from "./repo";
import { CreateReportCommand } from "./create-report";
import { SubmitCommand } from "./submit";
import { SetAutoCommand } from "./set-auto";
import { SetVerboseCommand } from "./set-verbose";

const commandInstances: Command[] = [
  new RepoCommand(),
  new CreateReportCommand(),
  new SubmitCommand(),
  new SetAutoCommand(),
  new SetVerboseCommand(),
];

export const commands = commandInstances.map(c => c.data);

const commandMap = new Map<string, Command>();
for (const cmd of commandInstances) {
  commandMap.set(cmd.data.name, cmd);
}

export async function handleCommand(interaction: CommandInteraction) {
  const { commandName } = interaction;
  console.log("[handleCommand] Dispatching", commandName, "for user", interaction.user.tag);

  const cmd = commandMap.get(commandName);
  if (cmd) {
    await cmd.execute(interaction);
  } else {
    console.warn("[handleCommand] Unknown command:", commandName);
  }
}

import { CommandInteraction } from "discord.js";
import { Command } from "./Command";
import { RepoCommand } from "./repo";
import { botLog, botWarn } from "../../logging";
import { CreateReportCommand } from "./create-report";
import { SubmitCommand } from "./submit";
import { SetAutoCommand } from "./set-auto";
import { SetVerboseCommand } from "./set-verbose";
import { ClearSessionCommand } from "./clear-session";
import { SetQuickCommand } from "./set-quick";
import { UpdateCommand } from "./update";
import { CloseCommand } from "./close";
import { ResolveCommand } from "./resolve";
import { HelpCommand } from "./help";
import { JobsCommand } from "./jobs";
import { SettingsCommand } from "./settings";
import { ReviewMergeCommand } from "./review-merge";
import { ReviewCommand } from "./review";

const commandInstances: Command[] = [
  new RepoCommand(),
  new CreateReportCommand(),
  new SubmitCommand(),
  new SetAutoCommand(),
  new SetQuickCommand(),
  new SetVerboseCommand(),
  new HelpCommand(),
  new JobsCommand(),
  new SettingsCommand(),
  new ClearSessionCommand(),
  new UpdateCommand(),
  new CloseCommand(),
  new ResolveCommand(),
  new ReviewMergeCommand(),
  new ReviewCommand(),
];

export const commands = commandInstances.map(c => c.data);

const commandMap = new Map<string, Command>();
for (const cmd of commandInstances) {
  commandMap.set(cmd.data.name, cmd);
}

export async function handleCommand(interaction: CommandInteraction) {
  const { commandName } = interaction;
  botLog("[handleCommand] Dispatching", commandName, "for user", interaction.user.tag);

  const cmd = commandMap.get(commandName);
  if (cmd) {
    await cmd.execute(interaction);
  } else {
    botWarn("[handleCommand] Unknown command:", commandName);
  }
}

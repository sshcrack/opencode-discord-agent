import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { commands } from "./discord/commands";
import { botLog, botError } from "./logging";

interface DiscordCommand {
  id: string;
  name: string;
}

function getDiscordCommands(rest: REST, route: string): Promise<DiscordCommand[]> {
  return rest.get(route as `/${string}`) as Promise<DiscordCommand[]>;
}

export async function registerCommands() {
  const { DISCORD_TOKEN, CLIENT_ID: rawClientId, ALLOWED_GUILD_ID } = process.env;

  if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is required");
  if (!rawClientId) throw new Error("CLIENT_ID is required");

  const CLIENT_ID: string = rawClientId;
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const commandData: Array<{ name: string } & Record<string, unknown>> = commands.map((cmd) => {
    const json = cmd.toJSON();
    return json as { name: string } & Record<string, unknown>;
  });

  // Delete all guild commands before switching to global-only
  if (ALLOWED_GUILD_ID) {
    const guildRoute = Routes.applicationGuildCommands(CLIENT_ID, ALLOWED_GUILD_ID);
    const guildCommands = await getDiscordCommands(rest, guildRoute);
    if (guildCommands.length > 0) {
      botLog(
        `Deleting ${guildCommands.length} guild command(s):`,
        guildCommands.map((cmd) => cmd.name).join(", "),
      );
      await Promise.all(guildCommands.map((cmd) => rest.delete(`${guildRoute}/${cmd.id}`)));
    }
  }

  const route = Routes.applicationCommands(CLIENT_ID);

  const existing = await getDiscordCommands(rest, route);

  const localNames = new Set(commandData.map((cmd) => cmd.name));
  const stale = existing.filter((cmd) => !localNames.has(cmd.name));

  if (stale.length > 0) {
    botLog(
      `Removing ${stale.length} stale command(s):`,
      stale.map((cmd) => cmd.name).join(", "),
    );
    await Promise.all(
      stale.map((cmd) => rest.delete(`${route}/${cmd.id}`)),
    );
  }

  botLog(`Registering ${commandData.length} command(s)...`);
  await rest.put(route, { body: commandData });
  botLog("Successfully registered application commands.");
}

// CLI entry point — run directly via `bun run src/deploy-commands.ts`
if (import.meta.path === Bun.main) {
  registerCommands().catch((err) => {
    botError("Failed to register commands:", err);
    process.exit(1);
  });
}

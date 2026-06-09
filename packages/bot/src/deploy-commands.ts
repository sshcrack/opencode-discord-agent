import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { commands } from "./discord/commands";

const { DISCORD_TOKEN, CLIENT_ID: rawClientId, GUILD_ID } = process.env;

if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is required");
if (!rawClientId) throw new Error("CLIENT_ID is required");

const CLIENT_ID: string = rawClientId;

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

async function main() {
  const commandData = commands.map((cmd) => cmd.toJSON());

  const route: `/${string}` = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  const existing: any[] = (await rest.get(route)) as any[];

  const localNames = new Set(commandData.map((cmd) => cmd.name));
  const stale = existing.filter((cmd) => !localNames.has(cmd.name));

  console.log(existing, localNames, stale)
  if (stale.length > 0) {
    console.log(
      `Removing ${stale.length} stale command(s):`,
      stale.map((cmd) => cmd.name).join(", "),
    );
    await Promise.all(
      stale.map((cmd) => rest.delete(`${route}/${cmd.id}`)),
    );
  }

  console.log(`Registering ${commandData.length} command(s)...`);
  await rest.put(route, { body: commandData });
  console.log("Successfully registered application commands.");
}

main().catch((err) => {
  console.error("Failed to register commands:", err);
  process.exit(1);
});

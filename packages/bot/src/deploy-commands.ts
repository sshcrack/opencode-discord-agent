import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { commands } from "./discord/commands";

export async function registerCommands() {
  const { DISCORD_TOKEN, CLIENT_ID: rawClientId, ALLOWED_GUILD_ID } = process.env;

  if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is required");
  if (!rawClientId) throw new Error("CLIENT_ID is required");

  const CLIENT_ID: string = rawClientId;
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const commandData = commands.map((cmd) => cmd.toJSON());

  // Delete all guild commands before switching to global-only
  if (ALLOWED_GUILD_ID) {
    const guildRoute = Routes.applicationGuildCommands(CLIENT_ID, ALLOWED_GUILD_ID);
    const guildCommands = (await rest.get(guildRoute)) as any[];
    if (guildCommands.length > 0) {
      console.log(
        `Deleting ${guildCommands.length} guild command(s):`,
        guildCommands.map((cmd) => cmd.name).join(", "),
      );
      await Promise.all(guildCommands.map((cmd) => rest.delete(`${guildRoute}/${cmd.id}`)));
    }
  }

  const route = Routes.applicationCommands(CLIENT_ID);

  const existing = (await rest.get(route)) as any[];

  const localNames = new Set(commandData.map((cmd) => cmd.name));
  const stale = existing.filter((cmd) => !localNames.has(cmd.name));

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

// CLI entry point — run directly via `bun run src/deploy-commands.ts`
registerCommands().catch((err) => {
  console.error("Failed to register commands:", err);
  process.exit(1);
});

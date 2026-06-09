import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { appRouter, createContext, setDiscordClient } from "./router";
import { setupInteractions } from "./interactions";
import { setFallbackClient } from "./fallback";

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const port = parseInt(process.env.BOT_PORT || "3451", 10);

  if (!token || !clientId) {
    console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID");
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  setDiscordClient(client);
  setFallbackClient(client);
  setupInteractions(client);

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(token);

  const commands = (
    await Promise.all([
      import("./commands/create-report"),
      import("./commands/submit"),
      import("./commands/set-auto"),
      import("./commands/add-repository"),
      import("./commands/list-repositories"),
      import("./commands/remove-repository"),
    ])
  ).map((mod) => mod.data.toJSON());

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} slash commands`);

  // tRPC standalone HTTP server
  createHTTPServer({
    router: appRouter,
    createContext,
    basePath: "/trpc",
  }).listen(port);

  console.log(`tRPC server listening on :${port}/trpc`);

  await client.login(token);
  console.log(`Logged in as ${client.user?.tag}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

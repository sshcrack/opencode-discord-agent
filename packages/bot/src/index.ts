import { Client, GatewayIntentBits, Events, ActivityType } from "discord.js";
import { prisma } from "./db";
import { commands, handleCommand } from "./discord/commands";
import { handleAutocomplete, handleButton } from "./discord/interactions";
import { createTRPCServer } from "./trpc/server";

const {
  DISCORD_TOKEN,
  TRPC_PORT = "3000",
  SHARED_SECRET,
  ALLOWED_GUILD_ID,
  ALLOWED_USER_ID,
} = process.env;

if (!DISCORD_TOKEN) throw new Error("DISCORD_TOKEN is required");
if (!SHARED_SECRET) throw new Error("SHARED_SECRET is required");

function checkAccess(interaction: { guildId: string | null; user?: { id: string } }): boolean {
  if (ALLOWED_GUILD_ID && interaction.guildId !== ALLOWED_GUILD_ID) return false;
  if (ALLOWED_USER_ID && interaction.user?.id !== ALLOWED_USER_ID) return false;
  return true;
}

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  await c.application.commands.set(commands);
  console.log(`Registered ${commands.length} slash commands`);

  createTRPCServer(parseInt(TRPC_PORT));
});

client.on(Events.InteractionCreate, async (interaction) => {
  console.log("[InteractionCreate]", {
    type: interaction.type,
    id: interaction.id,
    user: interaction.user?.tag,
    userId: interaction.user?.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    isCommand: interaction.isCommand(),
    isAutocomplete: interaction.isAutocomplete(),
    isButton: interaction.isButton(),
    commandName: interaction.isCommand() ? (interaction as any).commandName : undefined,
    customId: interaction.isButton() ? (interaction as any).customId : undefined,
  });

  try {
    if (!checkAccess(interaction)) {
      console.log("[Access] Denied for user", interaction.user?.id, "guild", interaction.guildId);
      if (interaction.isRepliable()) {
        await interaction.reply({ content: ":x: You are not authorized to use this bot", ephemeral: true });
      }
      return;
    }

    if (interaction.isCommand()) {
      console.log("[Command] Handling", (interaction as any).commandName, "options:", JSON.stringify((interaction as any).options.data));
      await handleCommand(interaction);
    } else if (interaction.isAutocomplete()) {
      console.log("[Autocomplete] Focused option:", (interaction as any).options.getFocused());
      await handleAutocomplete(interaction);
    } else if (interaction.isButton()) {
      console.log("[Button] Custom ID:", (interaction as any).customId);
      await handleButton(interaction);
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: ":x: An error occurred", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN);

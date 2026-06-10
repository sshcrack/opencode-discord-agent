import { Client, GatewayIntentBits, Events, TextChannel } from "discord.js";
import { prisma } from "./db";
import { handleCommand } from "./discord/commands";
import { handleAutocomplete, handleButton } from "./discord/interactions";
import { createTRPCServer } from "./trpc/server";
import { checkWorkerOnline } from "./discord/fallback";

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

(globalThis as any).__discord_client = client;

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  createTRPCServer(parseInt(TRPC_PORT));

  // Post "Done." to the channel that triggered /update
  const updateChannel = await prisma.setting.findUnique({
    where: { key: "last_update_channel_id" },
  });
  if (updateChannel?.value) {
    try {
      const ch = await client.channels.fetch(updateChannel.value);
      if (ch?.isTextBased()) {
        await (ch as TextChannel).send("Done.");
      }
    } catch {
      // channel might be gone
    }
    await prisma.setting.delete({ where: { key: "last_update_channel_id" } }).catch(() => {});
  }

  const updatePresence = async () => {
    try {
      const online = await checkWorkerOnline();
      if (online) {
        c.user.setPresence({ activities: [{ name: "Worker online" }], status: "online" });
      } else {
        c.user.setPresence({ activities: [{ name: "Worker offline" }], status: "idle" });
      }
    } catch (err) {
      console.error("Failed to update presence:", err);
    }
  };

  await updatePresence();
  setInterval(updatePresence, 30_000);
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
    commandName: interaction.isCommand() ? interaction.commandName : undefined,
    customId: interaction.isButton() ? interaction.customId : undefined,
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
      console.log("[Command] Name:", interaction.commandName);
      await handleCommand(interaction);
    } else if (interaction.isAutocomplete()) {
      console.log("[Autocomplete] Focused option:", interaction.options.getFocused());
      await handleAutocomplete(interaction);
    } else if (interaction.isButton()) {
      console.log("[Button] Custom ID:", interaction.customId);
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

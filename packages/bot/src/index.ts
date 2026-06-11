import { Client, GatewayIntentBits, Events, TextChannel, ThreadChannel, ChannelType } from "discord.js";
import { prisma } from "./db";
import { registerCommands } from "./deploy-commands";
import { handleCommand } from "./discord/commands";
import { handleAutocomplete, handleButton } from "./discord/interactions";
import { recordAnswer, cancelQuestions } from "./discord/questions";
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

  // Register slash commands with Discord on every startup
  try {
    await registerCommands();
    console.log("[Startup] Slash commands registered");
  } catch (err) {
    console.error("[Startup] Failed to register slash commands:", err);
  }

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

  // Reconcile repo channels on startup
  try {
    const repos = await prisma.repository.findMany();
    for (const repo of repos) {
      if (repo.channelId) {
        try {
          const ch = await client.channels.fetch(repo.channelId);
          if (!ch) {
            console.warn(`[Startup] Channel ${repo.channelId} for repo ${repo.slug} no longer exists`);
          }
        } catch {
          console.warn(`[Startup] Failed to fetch channel ${repo.channelId} for repo ${repo.slug} — removing stale mapping`);
          await prisma.repository.update({
            where: { id: repo.id },
            data: { channelId: null },
          });
        }
      } else if (c.guilds.cache.size > 0) {
        for (const guild of c.guilds.cache.values()) {
          const existing = guild.channels.cache.find(ch => ch.name === repo.slug && ch.type === ChannelType.GuildText);
          if (existing) {
            await prisma.repository.update({
              where: { id: repo.id },
              data: { channelId: existing.id },
            });
            console.log(`[Startup] Bound existing channel #${existing.name} (${existing.id}) to repo ${repo.slug}`);
          }
        }
      }
    }
  } catch (err) {
    console.error("[Startup] Repo channel reconciliation error:", err);
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
      if (interaction.customId.startsWith("ask_ans:") || interaction.customId.startsWith("ask_cancel:")) {
        const parts = interaction.customId.split(":");
        const action = parts[0];
        const jobId = parseInt(parts[1]!);
        if (isNaN(jobId)) {
          await interaction.reply({ content: ":x: Invalid job ID", ephemeral: true });
          return;
        }

        if (action === "ask_cancel") {
          await interaction.reply({ content: "❌ Cancelled question flow.", ephemeral: true });
          await cancelQuestions(jobId);
        } else {
          const optionIdx = parseInt(parts[2]!);
          const job = await prisma.job.findUnique({ where: { id: jobId } });
          if (!job || !job.pendingQuestions) {
            await interaction.reply({ content: ":x: No pending questions for this job.", ephemeral: true });
            return;
          }
          const questions = JSON.parse(job.pendingQuestions) as { q: string; options: string[]; recommended: number }[];
          const currentIdx = job.pendingQuestionIndex ?? 0;
          const answer = questions[currentIdx]?.options[optionIdx] ?? "Unknown";
          await interaction.reply({ content: `✅ Selected: ${answer}`, ephemeral: true });
          await recordAnswer(jobId, answer);
        }
        return;
      }
      await handleButton(interaction);
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: ":x: An error occurred", ephemeral: true }).catch(() => {});
    }
  }
});

// Handle free-form answers to pending questions
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.channel.isThread()) return;

  try {
    const job = await prisma.job.findFirst({
      where: {
        threadId: message.channelId,
        pendingQuestions: { not: null },
      },
    });
    if (!job) return;

    const questions = JSON.parse(job.pendingQuestions!) as { q: string; options: string[]; recommended: number }[];
    const currentIdx = job.pendingQuestionIndex ?? 0;
    if (currentIdx >= questions.length) return;

    await recordAnswer(job.id, message.content);
  } catch { /* ignore */ }
});

client.login(DISCORD_TOKEN);

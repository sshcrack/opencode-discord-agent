import { Client, GatewayIntentBits, Events, ChannelType } from "discord.js";
import { prisma } from "./db";
import { registerCommands } from "./deploy-commands";
import { handleCommand } from "./discord/commands";
import { handleAutocomplete, handleButton } from "./discord/interactions";
import { recordAnswer, cancelQuestions, goBack, approveAnswers, redoQuestions } from "./discord/questions";
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

function parsePendingQuestions(
  data: string,
): { q: string; options: string[]; recommended: number }[] {
  return JSON.parse(data);
}

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

globalThis.__discord_client = client;

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
      if (ch?.isTextBased() && "send" in ch) {
        await ch.send("Done.");
      }
    } catch {
      // channel might be gone
    }
    await prisma.setting.delete({ where: { key: "last_update_channel_id" } }).catch(() => {});
  }

  // Reconcile repo channels on startup
  try {
    const repos = await prisma.repository.findMany();
    let createdCount = 0;
    let boundCount = 0;

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
            boundCount++;
            console.log(`[Startup] Bound existing channel #${existing.name} (${existing.id}) to repo ${repo.slug}`);
          } else {
            // No matching channel exists — create one
            try {
              let category = guild.channels.cache.find(
                ch => ch.name === "Repositories" && ch.type === ChannelType.GuildCategory,
              );
              if (!category) {
                category = await guild.channels.create({
                  name: "Repositories",
                  type: ChannelType.GuildCategory,
                  reason: "Auto-created for startup repo channel sync",
                });
                console.log("[Startup] Created Repositories category");
              }

              const created = await guild.channels.create({
                name: repo.slug,
                type: ChannelType.GuildText,
                parent: category.id,
                reason: `Auto-created for repository ${repo.slug}`,
              });

              await prisma.repository.update({
                where: { id: repo.id },
                data: { channelId: created.id },
              });
              createdCount++;
              console.log(`[Startup] Created channel #${repo.slug} (${created.id}) for repo ${repo.slug}`);
            } catch (err) {
              console.error(`[Startup] Failed to create channel for repo ${repo.slug}:`, err);
            }
          }
        }
      }
    }

    if (createdCount > 0 || boundCount > 0) {
      console.log(`[Startup] Repo channel sync complete — created ${createdCount}, bound ${boundCount}`);
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

  // ── Stale-job recovery: every 60s, release jobs from dead workers ──────
  setInterval(async () => {
    try {
      const staleJobs = await prisma.job.findMany({
        where: {
          status: { in: ["claimed", "planning", "plan_ready", "approved", "building"] },
          workerId: { not: null },
        },
      });

      const now = Date.now();
      const workerIds = [...new Set(staleJobs.map(j => j.workerId!))];

      // Batch-fetch all relevant worker lastSeen settings
      const settings = await prisma.setting.findMany({
        where: {
          key: { in: workerIds.map(id => `worker:${id}:lastSeen`) },
        },
      });
      const lastSeenMap = new Map(
        settings.map(s => [s.key.replace(/^worker:/, "").replace(/:lastSeen$/, ""), new Date(s.value).getTime()]),
      );

      const staleWorkerIds = workerIds.filter(id => {
        const lastSeen = lastSeenMap.get(id);
        return !lastSeen || (now - lastSeen > 120_000); // 2 min without heartbeat
      });

      if (staleWorkerIds.length > 0) {
        const result = await prisma.job.updateMany({
          where: {
            workerId: { in: staleWorkerIds },
            status: { in: ["claimed", "planning", "plan_ready", "approved", "building"] },
          },
          data: {
            status: "pending",
            workerId: null,
            planMd: null,
            opencodeSessionId: null,
            buildSessionId: null,
            pendingSuggestion: null,
            planEditToken: null,
            pendingQuestions: null,
            pendingQuestionIndex: null,
            pendingAnswers: null,
            statusMessageId: null,
          },
        });
        if (result.count > 0) {
          console.log(`[Stale-job sweep] Released ${result.count} job(s) from dead workers: ${staleWorkerIds.join(", ")}`);
        }
      }
    } catch (err) {
      console.error("[Stale-job sweep] Error:", err);
    }
  }, 60_000);
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
      if (
        interaction.customId.startsWith("ask_ans:") ||
        interaction.customId.startsWith("ask_cancel:") ||
        interaction.customId.startsWith("ask_back:") ||
        interaction.customId.startsWith("ask_approve:") ||
        interaction.customId.startsWith("ask_redo:")
      ) {
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
        } else if (action === "ask_back") {
          const job = await prisma.job.findUnique({ where: { id: jobId } });
          if (!job || !job.pendingQuestions) {
            await interaction.reply({ content: ":x: No pending questions.", ephemeral: true });
            return;
          }
          const currentIdx = job.pendingQuestionIndex ?? 0;
          if (currentIdx <= 0) {
            await interaction.reply({ content: ":x: Already at the first question.", ephemeral: true });
            return;
          }
          await interaction.reply({ content: "◀ Going back to previous question.", ephemeral: true });
          await goBack(jobId);
        } else if (action === "ask_approve") {
          await interaction.reply({ content: "✅ Answers confirmed, proceeding...", ephemeral: true });
          await approveAnswers(jobId);
        } else if (action === "ask_redo") {
          await interaction.reply({ content: "🔄 Restarting questions from the beginning.", ephemeral: true });
          await redoQuestions(jobId);
        } else {
          const optionIdx = parseInt(parts[2]!);
          const job = await prisma.job.findUnique({ where: { id: jobId } });
          if (!job || !job.pendingQuestions) {
            await interaction.reply({ content: ":x: No pending questions for this job.", ephemeral: true });
            return;
          }
          const questions = parsePendingQuestions(job.pendingQuestions);
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

    const questions = parsePendingQuestions(job.pendingQuestions!);
    const currentIdx = job.pendingQuestionIndex ?? 0;
    if (currentIdx >= questions.length) return;

    await recordAnswer(job.id, message.content);
  } catch { /* ignore */ }
});

process.on("SIGTERM", async () => {
  console.log("[SIGTERM] Shutting down gracefully...");
  const { gracefulShutdown } = await import("./trpc/server");
  await gracefulShutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[SIGINT] Shutting down gracefully...");
  const { gracefulShutdown } = await import("./trpc/server");
  await gracefulShutdown();
  process.exit(0);
});

client.login(DISCORD_TOKEN);

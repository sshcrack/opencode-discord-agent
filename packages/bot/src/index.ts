import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import { trpcRouter } from "@discord-agent/shared";
import { prisma } from "./db";
import {
  handleHeartbeat,
  handlePollNextJob,
  handlePostStatus,
  handlePlanReady,
  handleApprovePlan,
  handleSuggestChange,
  setQueueClient,
} from "./queue";
import { setupInteractions } from "./interactions";
import { setFallbackClient } from "./fallback";

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const port = parseInt(process.env.BOT_PORT || "3451", 10);
  const secret = process.env.WORKER_SECRET;

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

  setQueueClient(client);
  setFallbackClient(client);
  setupInteractions(client);

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(token);

  const commands = (
    await Promise.all([
      import("./commands/create-report"),
      import("./commands/submit"),
      import("./commands/set-auto"),
    ])
  ).map((mod) => mod.data.toJSON());

  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} slash commands`);

  // tRPC HTTP server via Bun.serve
  Bun.serve({
    port,
    async fetch(req: Request) {
      const auth = req.headers.get("authorization");
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (secret && bearer !== secret) {
        return new Response("Unauthorized", { status: 401 });
      }

      const url = new URL(req.url);
      const path = url.pathname.replace("/trpc/", "");

      if (req.method === "POST" && path === "heartbeat") {
        const body = await req.json() as any;
        await handleHeartbeat(body.workerId ?? body[0]?.workerId);
        return Response.json([{ result: { data: { ok: true } } }]);
      }

      if (req.method === "GET" && path === "pollNextJob") {
        const raw = url.searchParams.get("input");
        if (!raw) return Response.json([{ result: { data: { job: null } } }]);
        const parsed = JSON.parse(raw);
        const result = await handlePollNextJob(parsed.workerId);
        return Response.json([{ result: { data: result } }]);
      }

      if (req.method === "POST" && path === "postStatus") {
        const body = await req.json() as any;
        await handlePostStatus(body);
        return Response.json([{ result: { data: { ok: true } } }]);
      }

      if (req.method === "POST" && path === "planReady") {
        const body = await req.json() as any;
        await handlePlanReady(body);
        return Response.json([{ result: { data: { ok: true } } }]);
      }

      if (req.method === "POST" && path === "approvePlan") {
        const body = await req.json() as any;
        await handleApprovePlan(body);
        return Response.json([{ result: { data: { ok: true } } }]);
      }

      if (req.method === "POST" && path === "suggestChange") {
        const body = await req.json() as any;
        await handleSuggestChange(body);
        return Response.json([{ result: { data: { ok: true } } }]);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`tRPC server listening on :${port}`);

  await client.login(token);
  console.log(`Logged in as ${client.user?.tag}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

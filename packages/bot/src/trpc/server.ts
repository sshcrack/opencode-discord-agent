import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { handlePlanGet, handlePlanPut, handlePlanApprove } from "./planApi";
import { prisma } from "../db";
import { botLog, botError } from "../logging";

let trpcServer: ReturnType<typeof Bun.serve> | null = null;

const PLAN_VIEWER_PREFIX = "/plan-viewer";
const PLAN_API_PREFIX = "/api/plans";
const TRPC_PREFIX = "/trpc";

function guessMimeType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export function getTRPCServer() {
  return trpcServer;
}

export function stopTRPCServer() {
  trpcServer?.stop();
  trpcServer = null;
}

export async function gracefulShutdown(): Promise<void> {
  botLog("[Shutdown] Releasing all in-flight jobs...");

  const result = await prisma.job.updateMany({
    where: {
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

  botLog(`[Shutdown] Released ${result.count} job(s)`);

  stopTRPCServer();
  await prisma.$disconnect();
  botLog("[Shutdown] Complete");
}

export function createTRPCServer(port: number) {
  trpcServer = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;

      if (pathname.startsWith(PLAN_API_PREFIX)) {
        const rest = pathname.slice(PLAN_API_PREFIX.length);
        const approveMatch = rest.match(/^\/(\d+)\/approve$/);
        const match = rest.match(/^\/(\d+)$/);

        if (approveMatch) {
          const jobId = parseInt(approveMatch[1]!, 10);
          if (req.method === "POST") {
            const token = url.searchParams.get("token");
            return handlePlanApprove(jobId, token);
          }
          if (req.method === "OPTIONS") {
            return corsPreflight();
          }
          return new Response("Method not allowed", { status: 405 });
        }

        if (!match) {
          return new Response("Not found", { status: 404 });
        }
        const jobId = parseInt(match[1]!, 10);

        if (req.method === "GET") {
          return handlePlanGet(jobId);
        }

        if (req.method === "PUT") {
          const token = url.searchParams.get("token");
          let body: unknown = {};
          try {
            body = await req.json();
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          return handlePlanPut(jobId, token, body as { planMd?: string });
        }

        if (req.method === "OPTIONS") {
          return corsPreflight();
        }

        return new Response("Method not allowed", { status: 405 });
      }

      if (pathname.startsWith(PLAN_VIEWER_PREFIX)) {
        let filePath = pathname.slice(PLAN_VIEWER_PREFIX.length) || "/index.html";
        if (filePath === "/" || filePath === "") {
          filePath = "/index.html";
        }

        const dir = import.meta.dir ?? "";
        const fullPath = `${dir}/../../public/plan-viewer${filePath}`;
        const file = Bun.file(fullPath);
        const exists = await file.exists();
        if (!exists) {
          return new Response("Not found", { status: 404 });
        }

        const mime = guessMimeType(filePath);
        return new Response(file, {
          headers: { "Content-Type": mime },
        });
      }

      if (pathname.startsWith(TRPC_PREFIX)) {
        const authHeader = req.headers.get("authorization");
        const expected = `Bearer ${process.env.SHARED_SECRET}`;
        if (!authHeader || authHeader !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        return fetchRequestHandler({
          endpoint: TRPC_PREFIX,
          req,
          router: appRouter,
          createContext: () => ({}),
          onError({ error }) {
            botError("tRPC error:", error);
          },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  botLog(`tRPC server listening on port ${port}`);
}

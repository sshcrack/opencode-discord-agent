import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";

let trpcServer: ReturnType<typeof Bun.serve> | null = null;

export function getTRPCServer() {
  return trpcServer;
}

export function stopTRPCServer() {
  trpcServer?.stop();
  trpcServer = null;
}

export function createTRPCServer(port: number) {
  trpcServer = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/trpc")) {
        const authHeader = req.headers.get("authorization");
        const expected = `Bearer ${process.env.SHARED_SECRET}`;
        if (!authHeader || authHeader !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        return fetchRequestHandler({
          endpoint: "/trpc",
          req,
          router: appRouter,
          createContext: () => ({}),
          onError({ error }) {
            console.error("tRPC error:", error);
          },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.log(`tRPC server listening on port ${port}`);
}

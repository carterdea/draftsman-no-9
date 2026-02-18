import { parseInvocationMode } from "@draftsman/core";

export function createApiFetchHandler() {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "api" });
    }

    if (url.pathname === "/webhooks/trello" && req.method === "POST") {
      const payload = (await req.json()) as { text?: string };
      const mode = parseInvocationMode(payload.text);

      return Response.json({
        accepted: true,
        mode,
      });
    }

    return new Response("Not Found", { status: 404 });
  };
}

export function createApiServer(port = Number(Bun.env.PORT ?? 3000)) {
  return Bun.serve({
    port,
    fetch: createApiFetchHandler(),
  });
}

if (import.meta.main) {
  const server = createApiServer();

  console.log(`[api] listening on http://localhost:${server.port}`);
}

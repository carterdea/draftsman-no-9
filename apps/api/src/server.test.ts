import { describe, expect, test } from "bun:test";

import { createApiFetchHandler } from "./server";

describe("api fetch handler", () => {
  test("returns health response", async () => {
    const fetch = createApiFetchHandler();
    const response = await fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "api" });
  });

  test("parses trello fix invocation", async () => {
    const fetch = createApiFetchHandler();
    const response = await fetch(
      new Request("http://localhost/webhooks/trello", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "@draftsman fix" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, mode: "fix" });
  });

  test("returns 404 for unknown route", async () => {
    const fetch = createApiFetchHandler();
    const response = await fetch(new Request("http://localhost/unknown"));

    expect(response.status).toBe(404);
  });
});

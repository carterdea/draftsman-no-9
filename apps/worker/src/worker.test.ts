import { describe, expect, test } from "bun:test";

import { getWorkerModeSupportLine, resolveWorkerPollMs } from "./worker";

describe("resolveWorkerPollMs", () => {
  test("uses default poll interval when env is missing", () => {
    expect(resolveWorkerPollMs(undefined)).toBe(5000);
  });

  test("uses default poll interval when env is invalid", () => {
    expect(resolveWorkerPollMs("not-a-number")).toBe(5000);
    expect(resolveWorkerPollMs("-1")).toBe(5000);
    expect(resolveWorkerPollMs("0")).toBe(5000);
  });

  test("uses configured poll interval when env is valid", () => {
    expect(resolveWorkerPollMs("1500")).toBe(1500);
  });
});

test("mode support line references supported commands", () => {
  const line = getWorkerModeSupportLine();

  expect(line).toContain("investigate");
  expect(line).toContain("fix");
});

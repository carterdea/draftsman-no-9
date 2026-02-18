import { describe, expect, test } from "bun:test";

import { describeInvocation, parseInvocationMode } from "./index";

describe("parseInvocationMode", () => {
  test("parses investigate command", () => {
    expect(parseInvocationMode("@draftsman investigate")).toBe("investigate");
  });

  test("parses fix command with surrounding whitespace", () => {
    expect(parseInvocationMode("  @draftsman fix  ")).toBe("fix");
  });

  test("returns null for unsupported text", () => {
    expect(parseInvocationMode("hello there")).toBeNull();
  });
});

test("describeInvocation includes both supported modes", () => {
  expect(describeInvocation()).toContain("investigate");
  expect(describeInvocation()).toContain("fix");
});

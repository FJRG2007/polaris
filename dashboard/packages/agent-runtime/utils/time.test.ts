import { describe, expect, it } from "vitest";
import { isValidTimeString, parseTimeString, resolveTimeoutMs } from "./time.ts";

describe("parseTimeString", () => {
  it.each([
    ["10m", 600000], // 10 minutes
    ["1h", 3600000], // 1 hour
    ["30s", 30000], // 30 seconds
    ["1h30m", 5400000], // 1 hour 30 minutes
    ["10m12s", 612000], // 10 minutes 12 seconds
    ["1h30m45s", 5445000], // 1 hour 30 minutes 45 seconds
    ["2h", 7200000], // 2 hours
    ["90m", 5400000], // 90 minutes
    ["0m", 0], // 0 minutes (edge case)
    ["0s", 0], // 0 seconds (edge case)
  ])("parses '%s' to %d ms", (input, expected) => {
    expect(parseTimeString(input)).toBe(expected);
  });

  it.each([
    [""], // empty string
    ["abc"], // no numbers
    ["10"], // no unit
    ["10x"], // invalid unit
    ["h10m"], // hours without number
    ["m10"], // units before number
    ["10 m"], // space between number and unit
    ["-10m"], // negative number
    ["10.5m"], // decimal
    ["10m 30s"], // space between components
  ])("returns null for invalid input '%s'", (input) => {
    expect(parseTimeString(input)).toBeNull();
  });
});

describe("isValidTimeString", () => {
  it.each(["10m", "1h", "30s", "1h30m", "10m12s", "1h30m45s"])(
    "returns true for valid '%s'",
    (input) => {
      expect(isValidTimeString(input)).toBe(true);
    }
  );

  it.each(["", "abc", "10", "10x", "-10m", "10.5m"])("returns false for invalid '%s'", (input) => {
    expect(isValidTimeString(input)).toBe(false);
  });
});

describe("resolveTimeoutMs", () => {
  it.each([
    ["1h", 3_600_000],
    ["10m", 600_000],
    ["1h30m", 5_400_000],
  ])("returns ms for valid '%s'", (input, expected) => {
    expect(resolveTimeoutMs(input)).toBe(expected);
  });

  it("returns null for undefined input (no timeout configured)", () => {
    expect(resolveTimeoutMs(undefined)).toBeNull();
  });

  it.each([["0m"], ["0s"], ["0h"], ["0h0m0s"]])(
    "returns null for zero-value '%s' so the caller doesn't insta-timeout",
    (input) => {
      // 0ms setTimeout fires in the same tick - without this guard, a user
      // typo like "0m" rejected the run as "timed out after 0m" the instant
      // it started. see also the matching payload.timeout handling in main.ts.
      expect(resolveTimeoutMs(input)).toBeNull();
    }
  );

  it.each([["abc"], ["10"], ["10x"], ["-10m"], ["10.5m"], [""]])(
    "returns null for unparseable input '%s'",
    (input) => {
      expect(resolveTimeoutMs(input)).toBeNull();
    }
  );

  it("returns null for values past node's setTimeout ceiling (~24.8 days)", () => {
    // 2^31 - 1 ms = 2147483647 ms = 596h31m23s647ms. node silently clamps any
    // delay above that down to 1ms - a user asking for "999h" would have the
    // run terminate with "timed out after 999h" within a single tick. reject
    // here so the caller's warn + fallback kicks in instead.
    expect(resolveTimeoutMs("999h")).toBeNull();
    // 600h = 2_160_000_000 ms, safely past the cap.
    expect(resolveTimeoutMs("600h")).toBeNull();
  });

  it("accepts the largest value that setTimeout can still honor", () => {
    // 596h31m23s = 2_147_483_000 ms - just under 2^31-1. this must remain
    // usable so the "reject over-max" rule doesn't accidentally reject the
    // boundary itself.
    expect(resolveTimeoutMs("596h31m23s")).toBe(2_147_483_000);
  });
});

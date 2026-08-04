import { describe, expect, it } from "vitest";
import { validateCompatibility } from "./versioning.ts";

describe("validateCompatibility", () => {
  it("should throw if payload version is invalid", () => {
    expect(() => validateCompatibility("invalid", "1.0.0")).toThrow(/not a valid semantic version/);
  });

  it.each([
    ["1.0.0", "1.0.0"], // same
    ["1.0.0-alpha.1", "1.0.0"], // action is newer than pre-release
    ["0.1.0", "0.1.1"], // action is newer during active development
    ["0.0.158", "0.0.158"], // bug #129
    ["0.0.159", "0.0.158"], // bug #129
    ["0.0.158", "0.0.159"], // bug #129
    ["1.0.0", "1.0.1"], // action patched
    ["1.0.0", "1.1.0"], // action has a new feature (backward compatible)
    ["1.0.1", "1.0.0"], // payload is newer (patch)
    ["1.1.0", "1.0.0"], // payload is newer (feature is backward compatible)
  ])("should accept compatible payload %#", (payloadVersion, actionVersion) => {
    expect(() => validateCompatibility(payloadVersion, actionVersion)).not.toThrow();
  });

  it.each([
    ["0.1.0", "0.2.0"], // action had breaking changes during active development
    ["0.2.0", "0.1.0"], // payload had breaking changes during active development
    ["2.0.0", "1.0.0"], // payload is majorly newer
    ["1.0.0", "2.0.0"], // action had breaking changes
  ])("should reject incompatible payload %#", (payloadVersion, actionVersion) => {
    expect(() => validateCompatibility(payloadVersion, actionVersion)).toThrow(
      /is incompatible with action version/
    );
  });
});

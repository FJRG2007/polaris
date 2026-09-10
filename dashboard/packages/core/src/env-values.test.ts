/**
 * The values a container's environment can hold, by the host daemon's own rule:
 * nothing below a space, and no DEL.
 */

import { describe, expect, it } from "vitest";
import { assertEnvValues, envValueMessage, hasControlCharacter } from "./env-values.js";

describe("what a container's environment can hold", () => {
    it("refuses exactly what the daemon refuses", () => {
        for (const bad of ["a\nb", "a\tb", "a\rb", "a\u0000b", "a\u001bb", "a\u007fb"]) {
            expect(hasControlCharacter(bad), JSON.stringify(bad)).toBe(true);
        }
        for (const good of [
            "",
            "plain value",
            "p@ss=w\u00f6rd",
            "a\u0085b",
            "\u00a0",
            "emoji \u{1f600}"
        ]) {
            expect(hasControlCharacter(good), JSON.stringify(good)).toBe(false);
        }
    });

    it("names the variable it refuses", () => {
        expect(() => assertEnvValues({ OK: "x", PEM: "-----BEGIN KEY-----\nabc" })).toThrow(
            envValueMessage("PEM")
        );
        expect(() => assertEnvValues({ OK: "x" })).not.toThrow();
    });
});

/**
 * The settings values a runtime will refuse.
 *
 * Free text in a settings field is not free when the value is handed to a JVM:
 * `8G` runs and `8GB` is a fatal argument, and the failure is silent in the only
 * place anybody looks - the container comes up, dies, and comes up again. A
 * server on this instance sat in that loop for ten days.
 *
 * So the two halves are pinned here: what gets corrected on the way in, and what
 * has to be refused instead of quietly stored.
 */

import { describe, expect, it } from "vitest";
import { envFormatHint, isAllowedEnvValue, normalizeEnvValue, type TemplateEnvVar } from "@/lib/apps/catalog";

const memory: TemplateEnvVar = { key: "MEMORY", label: "Memory", format: "jvm-heap" };
const motd: TemplateEnvVar = { key: "MOTD", label: "Message of the day" };

/** Store a value the way the save path does: normalize, then judge. */
function save(field: TemplateEnvVar, typed: string): string | null {
    const value = normalizeEnvValue(field, typed);
    return isAllowedEnvValue(field, value) ? value : null;
}

describe("a heap somebody typed", () => {
    it("corrects the unit people actually write", () => {
        // The exact value that took the server down, and the shapes next to it.
        expect(save(memory, "8GB")).toBe("8G");
        expect(save(memory, "8 gb")).toBe("8G");
        expect(save(memory, " 2048mb ")).toBe("2048M");
        expect(save(memory, "512KB")).toBe("512K");
    });

    it("leaves what was already right alone", () => {
        expect(save(memory, "2G")).toBe("2G");
        expect(save(memory, "1536M")).toBe("1536M");
    });

    it("refuses a size with no unit rather than guessing one", () => {
        // A bare number is bytes to the JVM, which nobody means. Guessing
        // megabytes would be a value nobody chose, silently.
        expect(save(memory, "2048")).toBeNull();
        expect(save(memory, "8")).toBeNull();
    });

    it("refuses what is not a size at all", () => {
        expect(save(memory, "mucha")).toBeNull();
        expect(save(memory, "")).toBeNull();
        expect(save(memory, "8G 8G")).toBeNull();
        // Not a heap and not silently truncated to one.
        expect(save(memory, "-Xmx8G")).toBeNull();
    });

    it("says what shape it wanted", () => {
        expect(envFormatHint(memory)).toContain("2G");
    });
});

describe("a field with no format", () => {
    it("still trims, and still takes ordinary text", () => {
        expect(save(motd, "  A server  ")).toBe("A server");
        expect(save(motd, "8GB")).toBe("8GB");
    });
});

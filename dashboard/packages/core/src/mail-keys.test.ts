/**
 * Mail's keyboard, as something a person can move.
 *
 * The rules worth pinning are the ones that stop a moved key from doing the
 * wrong thing: one key does one thing, a chord or a named key cannot be bound,
 * and the keys every list is driven by stay where they are whatever else moves.
 */

import { describe, expect, it } from "vitest";
import {
    MAIL_KEY_DEFINITIONS,
    cleanMailKeymap,
    isBindableMailKey,
    mailKeyConflicts,
    mailKeyFor,
    mailKeymapSchema,
    resolveMailKeymap
} from "./mail-keys.js";

describe("the keyboard as it ships", () => {
    it("has no key doing two things", () => {
        expect(mailKeyConflicts({}).size).toBe(0);
    });

    it("answers every default and every fixed key", () => {
        const keys = resolveMailKeymap({});
        expect(keys.get("e")).toBe("archive");
        expect(keys.get("i")).toBe("important");
        expect(keys.get("p")).toBe("pin");
        expect(keys.get("m")).toBe("mute");
        expect(keys.get("Delete")).toBe("trash");
        expect(keys.get("ArrowDown")).toBe("next");
        expect(keys.get("Escape")).toBe("back");
    });
});

describe("moving a shortcut", () => {
    it("moves the letter and leaves the fixed keys bound", () => {
        const keys = resolveMailKeymap({ trash: "x", next: "n" });
        expect(keys.get("x")).toBe("trash");
        expect(keys.get("#")).toBeUndefined();
        expect(keys.get("Delete")).toBe("trash");
        expect(keys.get("n")).toBe("next");
        expect(keys.get("ArrowDown")).toBe("next");
    });

    it("refuses a key another command already has, naming both", () => {
        const parsed = mailKeymapSchema.safeParse({ archive: "s" });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.message).toContain("archive");
        expect(parsed.error?.issues[0]?.message).toContain("star");
    });

    it("allows a swap, when both halves are moved together", () => {
        const parsed = mailKeymapSchema.safeParse({ archive: "s", star: "e" });
        expect(parsed.success).toBe(true);
        expect(parsed.data).toEqual({ archive: "s", star: "e" });
    });

    it("refuses what could never fire, and the keys that are not on offer", () => {
        expect(isBindableMailKey("ab")).toBe(false);
        expect(isBindableMailKey(" ")).toBe(false);
        expect(isBindableMailKey("Enter")).toBe(false);
        expect(isBindableMailKey("Delete")).toBe(false);
        expect(isBindableMailKey("y")).toBe(true);
        expect(mailKeymapSchema.safeParse({ open: "o" }).success).toBe(false);
        expect(mailKeymapSchema.safeParse({ nonsense: "q" }).success).toBe(false);
    });

    it("stores a key moved back onto its own default as no change at all", () => {
        expect(cleanMailKeymap({ archive: MAIL_KEY_DEFINITIONS.archive.key })).toEqual({});
        expect(mailKeyFor("archive", {})).toBe("e");
    });
});

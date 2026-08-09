/**
 * A field that holds a list, read two ways.
 *
 * `tokenList` is what gets submitted; `tokenAt` is what the picker under the
 * field is answering about. They have to agree on where one entry ends, because
 * a picker that thought the caret was inside "alice, bob" as a whole would
 * replace both names with the one that was chosen.
 */

import { describe, expect, it } from "vitest";
import { tokenAt, tokenList } from "@/lib/token-field";

describe("the list a field submits", () => {
    it("splits on either separator and stores one copy of each", () => {
        expect(tokenList("alice, bob alice", /^@+/)).toEqual(["alice", "bob"]);
    });

    it("drops the decoration in front of an entry", () => {
        expect(tokenList("@alice, bob@example.com", /^@+/)).toEqual(["alice", "bob@example.com"]);
        expect(tokenList(".png, .jpg", /^\./)).toEqual(["png", "jpg"]);
    });

    it("reads an empty field as no entries rather than as one blank", () => {
        expect(tokenList("  ,  ", /^@+/)).toEqual([]);
    });
});

describe("the entry the caret is inside", () => {
    it("finds the one being typed, not the whole field", () => {
        const text = "alice, bob";
        expect(tokenAt(text, 9, true)).toEqual({ start: 7, end: 10, value: "bob" });
        expect(tokenAt(text, 2, true)).toEqual({ start: 0, end: 5, value: "alice" });
    });

    it("is empty between two entries, where there is nothing to look up", () => {
        expect(tokenAt("alice, bob", 6, true).value).toBe("");
    });

    it("takes the whole field when it holds a single account, spaces and all", () => {
        expect(tokenAt("Ana Ruiz", 3, false)).toEqual({ start: 0, end: 8, value: "Ana Ruiz" });
    });

    it("survives a caret outside the text", () => {
        expect(tokenAt("alice", 99, true).value).toBe("alice");
        expect(tokenAt("alice", -1, true).value).toBe("alice");
    });
});

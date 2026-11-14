import { describe, expect, it } from "vitest";
import { keyHint } from "@/lib/agents/key-hint";

describe("keyHint", () => {
    it("shows a vendor prefix and the last five of a long key", () => {
        expect(keyHint("gsk_abcdefghijklmnopqrstuvwxyz16189")).toBe("gsk_...16189");
        expect(keyHint("sk-ant-api03-abcdefghijklmnop12345")).toBe("sk-ant-...12345");
    });

    it("shows four characters of a long key with no prefix", () => {
        expect(keyHint("abcdefghijklmnopqrstuvwxyz")).toBe("abcd...vwxyz");
    });

    it("reveals only the last four of a short key", () => {
        expect(keyHint("dm_12345abcd")).toBe("...abcd");
        expect(keyHint("  shortkey99  ")).toBe("...ey99");
    });

    it("gives nothing for what is not a single key", () => {
        expect(keyHint("")).toBe("");
        expect(keyHint("abc1234")).toBe("");
        expect(keyHint("unused-gateway")).toBe("");
        expect(keyHint('{"token": "abc"}')).toBe("");
        expect(keyHint("line one\nline two")).toBe("");
    });

    it("never contains the middle of the key", () => {
        const key = "sk-proj-SECRETMIDDLEPARTxyz12345";
        expect(keyHint(key)).not.toContain("SECRET");
    });
});

/**
 * The copy of a conversation the embed hands the extension's panel, for when
 * Polaris does not answer: cut to the caps, only spoken lines, and read by the
 * panel with the same shape and caps (`apps/extension/src/lib/polar-offline.ts`).
 */

import { describe, expect, it } from "vitest";
import * as bridge from "@/lib/polar/embed-bridge";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lines = (count: number) =>
    Array.from({ length: count }, (_, at) => ({
        role: at % 2 ? "assistant" : "user",
        text: `line ${at}`
    }));

describe("snapshotOf", () => {
    it("keeps the newest spoken lines, cut to the caps", () => {
        const snapshot = bridge.snapshotOf("user-1", {
            id: "thread-1",
            at: 1000,
            lines: [
                { role: "system", text: "hidden" },
                { role: "user", text: "   " },
                ...lines(60),
                { role: "assistant", text: "x".repeat(bridge.SNAPSHOT_TEXT + 50) }
            ]
        });
        expect(snapshot).not.toBeNull();
        const messages = snapshot!.conversation.messages;
        expect(messages).toHaveLength(bridge.SNAPSHOT_MESSAGES);
        expect(messages.at(-1)!.text).toHaveLength(bridge.SNAPSHOT_TEXT);
        expect(messages.some((message) => message.text === "hidden")).toBe(false);
        expect(snapshot!.conversation.title.length).toBeLessThanOrEqual(bridge.SNAPSHOT_TITLE);
    });

    it("has nothing to keep for a conversation with no words", () => {
        expect(bridge.snapshotOf("user-1", { id: "t", at: 0, lines: [] })).toBeNull();
    });

    it("refuses anything outside the shape", () => {
        const good = bridge.snapshotOf("user-1", { id: "t", at: 1, lines: lines(2) })!;
        expect(bridge.snapshotFrom(good)).toEqual(good);
        expect(bridge.snapshotFrom({ ...good, source: "polaris-extension" })).toBeNull();
        expect(bridge.snapshotFrom({ ...good, account: "" })).toBeNull();
        const tooMany = { ...good.conversation, messages: lines(41) };
        expect(bridge.snapshotFrom({ ...good, conversation: tooMany })).toBeNull();
    });
});

describe("the panel's end of it", () => {
    // Read as text: the extension's sources need its own build step to load.
    const source = readFileSync(
        fileURLToPath(new URL("../../../extension/src/lib/polar-offline.ts", import.meta.url)),
        "utf8"
    );
    const cap = (name: string) => {
        const match = new RegExp(`export const ${name} = ([0-9_]+);`).exec(source);
        return match ? Number(match[1].replace(/_/g, "")) : Number.NaN;
    };

    it("uses the embed's caps", () => {
        expect(cap("SNAPSHOT_MESSAGES")).toBe(bridge.SNAPSHOT_MESSAGES);
        expect(cap("SNAPSHOT_TEXT")).toBe(bridge.SNAPSHOT_TEXT);
        expect(cap("SNAPSHOT_TITLE")).toBe(bridge.SNAPSHOT_TITLE);
    });

    it("listens for the kind and source the embed sends", () => {
        const sent = bridge.snapshotOf("user-1", { id: "t", at: 5, lines: lines(1) })!;
        expect(sent.kind).toBe("snapshot");
        expect(source).toContain('data.kind !== "snapshot"');
        expect(source).toContain("data.source !== FROM_EMBED");
    });
});

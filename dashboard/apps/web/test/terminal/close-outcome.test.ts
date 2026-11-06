/**
 * What a terminal says when its socket closes.
 *
 * The sidecar accepts the WebSocket before it redeems the ticket or dials the
 * server, so every refusal arrives on a socket that has already opened. Reading
 * "opened" as "ran and ended" is what turned a server that had moved, a changed
 * host key and a refused login all into the one word "disconnected".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enUS from "../../messages/en-US/common.json";
import esES from "../../messages/es-ES/common.json";
import {
    CLOSE_REASONS,
    closeOutcome,
    searchOutcome
} from "../../src/app/(app)/apps/deploy/terminal-panel";

describe("closeOutcome", () => {
    it("reads a refusal after the socket opened as that refusal", () => {
        expect(closeOutcome(true, 4003, "server unreachable")).toEqual({
            status: { kind: "couldNotConnect" },
            failure: { kind: "refused", reason: "server unreachable" }
        });
    });

    it("reads a session that ran and ended as disconnected", () => {
        expect(closeOutcome(true, 1000, "")).toEqual({
            status: { kind: "disconnected" },
            failure: null
        });
        expect(closeOutcome(true, 1005, "")).toEqual({
            status: { kind: "disconnected" },
            failure: null
        });
    });

    it("shows a reason it has no sentence for as it came", () => {
        expect(closeOutcome(true, 4009, "something new")).toEqual({
            status: { kind: "reason", text: "something new" },
            failure: { kind: "refused", reason: "something new" }
        });
    });

    it("reads a silent close that never opened as never reaching the sidecar", () => {
        expect(closeOutcome(false, 1006, "")).toEqual({
            status: { kind: "couldNotConnect" },
            failure: { kind: "unreachable" }
        });
    });
});

describe("the sidecar's close reasons", () => {
    const source = readFileSync(new URL("../../ws-server.mjs", import.meta.url), "utf8");
    // Every literal reason a `ws.close(4xxx, "...")` sends, plus the words the
    // ssh failure kinds close with.
    const literal = [...source.matchAll(/ws\.close\(4\d{3},\s*"([^"]+)"\)/g)].map((m) => m[1]);
    const sshBlock = source.match(/const SSH_CLOSE_REASONS = \{([\s\S]*?)\};/)?.[1] ?? "";
    const ssh = [...sshBlock.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
    const reasons = [...literal, ...ssh];

    it("are found in the sidecar", () => {
        expect(literal.length).toBeGreaterThan(3);
        expect(ssh).toHaveLength(4);
    });

    it("each have a sentence in both languages", () => {
        const en = enUS.terminal.reasons as Record<string, string>;
        const es = esES.terminal.reasons as Record<string, string>;
        for (const reason of reasons) {
            const key = CLOSE_REASONS[reason];
            expect(key, reason).toBeDefined();
            expect(en[key], key).toBeTruthy();
            expect(es[key], key).toBeTruthy();
        }
    });
});

describe("searchOutcome", () => {
    it("opens the shell again when the server was moved or answers where it is recorded", () => {
        expect(searchOutcome({ found: "192.0.2.20" })).toBe("retry");
        expect(searchOutcome({ path: { kind: "already", address: "192.0.2.10" } })).toBe("retry");
        expect(searchOutcome({ path: { kind: "none" } })).toBe("retry");
        expect(
            searchOutcome({ path: { kind: "found", address: "192.0.2.10", moved: false } })
        ).toBe("retry");
    });

    it("says it could not look when Polaris does not know its own address", () => {
        expect(searchOutcome({ path: { kind: "unknown" } })).toEqual({ kind: "cannotLook" });
    });

    it("says it is not on the network only after a search that found nothing", () => {
        expect(searchOutcome({ path: { kind: "unreachable" } })).toEqual({ kind: "notFound" });
        expect(searchOutcome(null)).toEqual({ kind: "notFound" });
    });

    it("shows the reason a search failed", () => {
        expect(searchOutcome({ error: "Could not look" })).toEqual({
            kind: "error",
            text: "Could not look"
        });
    });
});

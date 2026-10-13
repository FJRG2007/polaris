/**
 * An IMAP failure that lands after the connection settled is logged, not thrown.
 *
 * imapflow reports a late failure - a socket timeout during its own session
 * setup, a connection dropped between commands - as an `error` event, and an
 * `error` event with no listener is thrown. Inside imapflow's promise chain that
 * surfaced as an unhandled rejection ("Connection not available", ENABLE) in
 * the server log after a Gmail sync timed out.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const clients: EventEmitter[] = [];

vi.mock("imapflow", () => ({
    ImapFlow: class extends EventEmitter {
        constructor() {
            super();
            clients.push(this);
        }
        async connect() {}
        async logout() {}
        close() {}
    }
}));

vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: class extends Error {},
    mailCredential: async () => ({
        kind: "password",
        user: "fixture@example.test",
        pass: "fixture"
    })
}));

const { checkImap, withImap } = await import("@/lib/mailbox/imap");

const ACCOUNT = { imapHost: "imap.example.test", imapPort: 993, imapSecurity: "tls" } as never;

describe("a late IMAP error", () => {
    afterEach(() => {
        clients.length = 0;
        vi.restoreAllMocks();
    });

    it("is logged on a working connection instead of thrown", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await withImap(ACCOUNT, async () => {
            expect(() =>
                clients[0].emit("error", new Error("Connection not available"))
            ).not.toThrow();
        });
        expect(warn).toHaveBeenCalledWith("imap:", "Connection not available");
    });

    it("is logged on the account form's check instead of thrown", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        await checkImap(ACCOUNT);
        expect(() => clients[0].emit("error", new Error("Socket timeout"))).not.toThrow();
    });
});

import { describe, expect, it, vi } from "vitest";
import { refusalCause } from "@/lib/mailbox/refusals";
import { refusedNotices } from "@/app/(app)/mail/refused-notice";

vi.mock("@/app/(app)/mail/actions", () => ({ syncAccountAction: async () => ({}) }));

const NOW = new Date("2026-11-02T10:00:00Z").getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function mailbox(id: string, lastOkAt: string | null, overrides = {}) {
    return {
        id,
        address: `${id}@example.test`,
        auth: "password",
        state: "auth",
        imapHost: "imap.example.test",
        lastOkAt,
        ...overrides
    };
}

describe("why a mailbox is refused", () => {
    it("blames the server when several went within minutes", () => {
        const all = [mailbox("a", ago(30)), mailbox("b", ago(28)), mailbox("c", ago(25))];
        expect(refusalCause(all[0], all, NOW)).toBe("server");
    });

    it("does not count a mailbox on another server, or one that still works", () => {
        const all = [
            mailbox("a", ago(120)),
            mailbox("b", ago(120), { imapHost: "imap.other.test" }),
            mailbox("c", ago(120), { state: "ok" })
        ];
        expect(refusalCause(all[0], all, NOW)).toBe("password");
    });

    it("keeps one that worked minutes ago a question until a retry was refused", () => {
        expect(refusalCause(mailbox("a", ago(20)), [], NOW)).toBe("recent");
        expect(refusalCause(mailbox("a", ago(61)), [], NOW)).toBe("password");
    });

    it("stops blaming the server after a day: a shared password can change", () => {
        const all = [mailbox("a", ago(25 * 60)), mailbox("b", ago(25 * 60))];
        expect(refusalCause(all[0], all, NOW)).toBe("password");
    });

    it("calls a mailbox that never worked a credential, and a token an authorization", () => {
        expect(refusalCause(mailbox("a", null), [], NOW)).toBe("password");
        expect(refusalCause(mailbox("a", ago(5), { auth: "oauth" }), [], NOW)).toBe("authorization");
    });
});

describe("notices", () => {
    it("says one thing about a server, however many mailboxes it refused", () => {
        const notices = refusedNotices(
            [mailbox("a", ago(30)), mailbox("b", ago(28)), mailbox("c", ago(25))].map((row) => ({
                ...row,
                auth: "password" as const
            })),
            NOW
        );
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ cause: "server", subject: "imap.example.test" });
        expect(notices[0]?.accountIds).toEqual(["a", "b", "c"]);
    });
});

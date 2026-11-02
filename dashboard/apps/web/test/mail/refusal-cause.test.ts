import { describe, expect, it, vi } from "vitest";
import { refusalCause } from "@/lib/mailbox/refusals";
import { refusedNotices } from "@/app/(app)/mail/refused-notice";

vi.mock("@/app/(app)/mail/actions", () => ({ syncAccountAction: async () => ({}) }));

const NOW = new Date("2026-11-02T10:00:00Z").getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** Refused `since` minutes ago and last refused `last` minutes ago, by default together. */
function mailbox(id: string, lastOkAt: string | null, since: number, last = since, overrides = {}) {
    return {
        id,
        address: `${id}@example.test`,
        auth: "password",
        state: "auth",
        imapHost: "imap.example.test",
        lastOkAt,
        refusedSince: ago(since),
        lastRefusedAt: ago(last),
        ...overrides
    };
}

describe("why a mailbox is refused", () => {
    it("blames the server when several went within minutes", () => {
        const all = [
            mailbox("a", ago(90), 30),
            mailbox("b", ago(90), 28),
            mailbox("c", ago(90), 25)
        ];
        expect(refusalCause(all[0], all, NOW)).toBe("server");
    });

    it("does not count a mailbox on another server, or one that still works", () => {
        const all = [
            mailbox("a", ago(200), 120, 10),
            mailbox("b", ago(200), 120, 10, { imapHost: "imap.other.test" }),
            mailbox("c", ago(200), 120, 10, { state: "ok" })
        ];
        expect(refusalCause(all[0], all, NOW)).toBe("password");
    });

    it("keeps a refusal a question until a retry an hour on was refused too", () => {
        expect(refusalCause(mailbox("a", ago(30), 20), [], NOW)).toBe("recent");
        expect(refusalCause(mailbox("a", ago(90), 61, 0), [], NOW)).toBe("password");
    });

    it("does not count an hour that held no second refusal", () => {
        expect(refusalCause(mailbox("a", ago(90), 61), [], NOW)).toBe("recent");
    });

    it("counts from the first refusal, not from when the mailbox last worked", () => {
        expect(refusalCause(mailbox("a", ago(48 * 60), 1), [], NOW)).toBe("recent");
    });

    it("stops blaming the server after a day: a shared password can change", () => {
        const all = [
            mailbox("a", ago(26 * 60), 25 * 60, 5),
            mailbox("b", ago(26 * 60), 25 * 60, 5)
        ];
        expect(refusalCause(all[0], all, NOW)).toBe("password");
    });

    it("calls a mailbox that never worked a credential, and a token an authorization", () => {
        expect(refusalCause(mailbox("a", null, 1), [], NOW)).toBe("password");
        expect(refusalCause(mailbox("a", ago(5), 1, 1, { auth: "oauth" }), [], NOW)).toBe(
            "authorization"
        );
    });
});

describe("notices", () => {
    it("says one thing about a server, however many mailboxes it refused", () => {
        const notices = refusedNotices(
            [mailbox("a", ago(90), 30), mailbox("b", ago(90), 28), mailbox("c", ago(90), 25)].map(
                (row) => ({
                    ...row,
                    auth: "password" as const
                })
            ),
            NOW
        );
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ cause: "server", subject: "imap.example.test" });
        expect(notices[0]?.accountIds).toEqual(["a", "b", "c"]);
    });
});

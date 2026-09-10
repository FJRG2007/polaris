/**
 * A mailbox whose server stopped accepting its password: paused, said once,
 * picked up again.
 *
 * Three rules, and each one is what makes the notice worth having:
 *
 * **Once.** The mailbox is refused again on every retry until somebody fixes it,
 * and a notification per retry is a bell nobody reads.
 *
 * **Cleared when it works.** A mailbox that recovers and is refused again a month
 * later is news again, or the second password change is the one nobody hears
 * about.
 *
 * **Not twice for one refusal.** A retry that cannot reach the server says
 * nothing about the password, and flipping the mailbox to "unreachable" and
 * back would announce the same refusal a second time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string;
    address: string;
    auth: string;
    connectionId: string | null;
    state: string;
    stateDetail: string;
    lastSyncAt: Date | null;
    lastOkAt: Date | null;
}

interface Notice {
    id: string;
    userId: string;
    type: string;
    metadata: string | null;
    readAt: Date | null;
    actionRequired: boolean;
}

const state = {
    rows: [] as Row[],
    notified: [] as { userId: string; event: string; title: string; href?: string | null }[],
    synced: [] as { id: string; force: boolean }[],
    notices: [] as Notice[],
    noticeReads: 0
};

type Where = { id?: string; connectionId?: string; state?: string | { not: string } };

function matches(row: Row, where: Where): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.connectionId !== undefined && row.connectionId !== where.connectionId) return false;
    if (typeof where.state === "string" && row.state !== where.state) return false;
    if (typeof where.state === "object" && row.state === where.state.not) return false;
    return true;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailAccount: {
            updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
                const hit = state.rows.filter((row) => matches(row, where));
                for (const row of hit) Object.assign(row, data);
                return { count: hit.length };
            }),
            update: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
                const row = state.rows.find((entry) => entry.id === where.id);
                if (row) Object.assign(row, data);
                return row;
            }),
            findUnique: vi.fn(
                async ({ where }: { where: Where }) =>
                    state.rows.find((row) => row.id === where.id) ?? null
            ),
            findMany: vi.fn(async ({ where }: { where: Where }) =>
                state.rows.filter((row) => matches(row, where))
            )
        },
        notification: {
            findMany: vi.fn(async ({ where }: { where: { userId: string; type: string } }) => {
                state.noticeReads += 1;
                return state.notices.filter(
                    (notice) =>
                        notice.userId === where.userId &&
                        notice.type === where.type &&
                        (notice.readAt === null || notice.actionRequired)
                );
            }),
            updateMany: vi.fn(
                async ({ where, data }: { where: { id: { in: string[] } }; data: Partial<Notice> }) => {
                    const hit = state.notices.filter((notice) => where.id.in.includes(notice.id));
                    for (const notice of hit) Object.assign(notice, data);
                    return { count: hit.length };
                }
            )
        }
    }
}));

vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: { userId: string; event: string; title: string; href?: string | null }) => {
        state.notified.push(input);
    }
}));

vi.mock("@/lib/mailbox/sync", () => ({
    syncAccount: async (id: string, options: { force?: boolean } = {}) => {
        state.synced.push({ id, force: options.force === true });
    }
}));

// `accounts.ts` is where a working pass writes "ok". Everything it reaches for
// beyond the database is a socket or the audit log, and none of it runs here.
vi.mock("@/lib/mailbox/send", () => ({ checkSmtp: async () => undefined }));
vi.mock("@/lib/mailbox/imap", () => ({ checkImap: async () => undefined }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/mailbox/access", () => ({
    ownedAccount: async () => ({}),
    ownedAccounts: async () => []
}));
vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: class MailAuthError extends Error {},
    grantsMailAccess: () => true,
    sealMailSecret: () => ({})
}));

const { recordCredentialRefusal, retryRefusedMailboxes } = await import("@/lib/mailbox/refused");
const { recordAccountState } = await import("@/lib/mailbox/accounts");

function mailbox(overrides: Partial<Row> = {}): Row {
    const row: Row = {
        id: "0190c1d2-0000-7000-8000-000000000001",
        userId: "usr_ana",
        address: "ana@example.com",
        auth: "password",
        connectionId: null,
        state: "ok",
        stateDetail: "",
        lastSyncAt: new Date("2026-09-10T08:00:00Z"),
        lastOkAt: new Date("2026-09-10T08:00:00Z"),
        ...overrides
    };
    state.rows = [row];
    return row;
}

beforeEach(() => {
    state.rows = [];
    state.notified = [];
    state.synced = [];
    state.notices = [];
    state.noticeReads = 0;
});

function notice(accountId: string, overrides: Partial<Notice> = {}): Notice {
    const row: Notice = {
        id: `notice-${state.notices.length + 1}`,
        userId: "usr_ana",
        type: "mail.account.refused",
        metadata: JSON.stringify({ accountId }),
        readAt: null,
        actionRequired: true,
        ...overrides
    };
    state.notices.push(row);
    return row;
}

describe("a mailbox the server stops accepting", () => {
    it("is paused and its owner is told, with the way to fix it", async () => {
        const row = mailbox();
        await recordCredentialRefusal(row.id, "The mail server refused this account's credentials.");

        expect(row.state).toBe("auth");
        expect(row.stateDetail).toBe("The mail server refused this account's credentials.");
        expect(state.notified).toHaveLength(1);
        expect(state.notified[0]?.event).toBe("mail.account.refused");
        expect(state.notified[0]?.userId).toBe("usr_ana");
        expect(state.notified[0]?.title).toBe("ana@example.com stopped accepting its password");
        expect(state.notified[0]?.href).toBe(`/mail/settings/accounts?edit=${row.id}`);
    });

    it("is announced once, however often it is refused", async () => {
        const row = mailbox();
        const before = row.lastSyncAt?.getTime() ?? 0;
        await recordCredentialRefusal(row.id, "refused");
        await recordCredentialRefusal(row.id, "refused");
        await recordCredentialRefusal(row.id, "refused");

        expect(state.notified).toHaveLength(1);
        // The clock still moves, which is what spaces the next try out.
        expect(row.lastSyncAt?.getTime()).toBeGreaterThan(before);
    });

    it("says reconnect, not password, for an authorized mailbox", async () => {
        const row = mailbox({ auth: "oauth", connectionId: "c1" });
        await recordCredentialRefusal(row.id, "This mailbox needs authorizing again.");
        expect(state.notified[0]?.title).toBe("ana@example.com needs connecting again");
    });

    it("starts over once the credential works again", async () => {
        const row = mailbox();
        await recordCredentialRefusal(row.id, "refused");
        await recordAccountState(row.id, "ok");
        expect(row.state).toBe("ok");
        expect(state.notified).toHaveLength(1);

        await recordCredentialRefusal(row.id, "refused");
        expect(row.state).toBe("auth");
        expect(state.notified).toHaveLength(2);
    });

    it("takes the notice off the bell once a pass works again, and only that mailbox's", async () => {
        const row = mailbox();
        await recordCredentialRefusal(row.id, "refused");
        const mine = notice(row.id, { readAt: new Date("2026-09-10T09:00:00Z") });
        const other = notice("0190c1d2-0000-7000-8000-000000000002");
        const unrelated = notice(row.id, { type: "mail.arrived" });

        await recordAccountState(row.id, "ok");

        expect(mine.actionRequired).toBe(false);
        expect(mine.readAt).toBeInstanceOf(Date);
        expect(other).toMatchObject({ readAt: null, actionRequired: true });
        expect(unrelated).toMatchObject({ readAt: null, actionRequired: true });
    });

    it("does not look at the bell on every pass of a mailbox that was already working", async () => {
        const row = mailbox();
        await recordAccountState(row.id, "ok");
        await recordAccountState(row.id, "ok");
        expect(row.state).toBe("ok");
        expect(state.noticeReads).toBe(0);
    });

    it("is not announced for a mailbox that is not there any more", async () => {
        await recordCredentialRefusal("0190c1d2-0000-7000-8000-00000000dead", "refused");
        expect(state.notified).toHaveLength(0);
    });
});

describe("authorizing an account again", () => {
    it("tries the refused mailboxes it covers at once, and only those", async () => {
        const refused = mailbox({ auth: "oauth", connectionId: "c1", state: "auth" });
        state.rows.push(
            { ...refused, id: "0190c1d2-0000-7000-8000-000000000002", state: "ok" },
            { ...refused, id: "0190c1d2-0000-7000-8000-000000000003", connectionId: "c2" }
        );
        await retryRefusedMailboxes("c1");
        expect(state.synced).toEqual([{ id: refused.id, force: true }]);
    });
});

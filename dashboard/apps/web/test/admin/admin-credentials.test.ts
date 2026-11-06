/**
 * What an administrator can do about somebody else's way in.
 *
 * The properties that matter are not on the happy path: the link exists only as
 * its hash, a new link retires the old one, nobody uses this on their own
 * account or on one above theirs, a temporary password holds the account on the
 * change-password step and ends every session, the email is only offered when
 * account mail exists, and an address already in use is refused.
 */

import { hashToken } from "@polaris/core/tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface UserRow {
    id: string;
    isAdmin: boolean;
    email: string;
    emailVerified: boolean;
    name: string;
    passwordChangeRequired: boolean;
}

let users: UserRow[] = [];
let tickets: { userId: string; tokenHash: string; status: string; expiresAt: Date }[] = [];
let limited = false;
let mailChannel: string | null = null;
let unsafe: string | null = null;
let takenBy: string | null = null;
const audits: { action: string; metadata?: Record<string, unknown> }[] = [];
const resetPassword = vi.fn(async () => ({}) as { error?: string });
const revokeSessions = vi.fn(async () => ({}));
const revokeGrants = vi.fn(async () => {});
const sendMail = vi.fn(async () => ({}) as { error?: string });
const notify = vi.fn(async () => {});
const revokeOthers = vi.fn(async () => 1);

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: vi.fn(
                async ({ where }: { where: { id: string } }) =>
                    users.find((u) => u.id === where.id) ?? null
            ),
            update: vi.fn(
                async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
                    const user = users.find((u) => u.id === where.id)!;
                    Object.assign(user, data);
                    return user;
                }
            )
        },
        accountRecovery: {
            updateMany: vi.fn(
                async ({
                    where,
                    data
                }: {
                    where: { userId: string };
                    data: { status: string };
                }) => {
                    for (const row of tickets) {
                        if (
                            row.userId === where.userId &&
                            ["pending", "approved"].includes(row.status)
                        )
                            row.status = data.status;
                    }
                    return { count: 0 };
                }
            ),
            create: vi.fn(async ({ data }: { data: (typeof tickets)[number] }) => {
                tickets.push({ ...data });
                return data;
            })
        },
        userEmail: { create: vi.fn(async () => ({})) },
        $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations))
    }
}));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@polaris/auth", () => ({
    resetUserPassword: (...args: unknown[]) => resetPassword(...(args as [])),
    emailOwner: async () => takenBy
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: { action: string; metadata?: Record<string, unknown> }) =>
        void audits.push(entry)
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () =>
        limited ? { ok: false, retryAfterMs: 120_000 } : { ok: true, retryAfterMs: 0 }
}));
vi.mock("@/lib/step-up-grant", () => ({
    revokeStepUpGrants: (...args: unknown[]) => revokeGrants(...(args as []))
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: async () => (key: string) => key }));
vi.mock("@/lib/notification-service", () => ({
    createNotification: (...args: unknown[]) => notify(...(args as []))
}));
vi.mock("@/lib/session-directory", () => ({
    revokeOtherSessions: (...args: unknown[]) => revokeOthers(...(args as []))
}));
vi.mock("@/lib/user-admin-service", () => ({
    revokeUserSessions: (...args: unknown[]) => revokeSessions(...(args as []))
}));
vi.mock("@/lib/auth-mail", () => ({
    getAuthMailStatus: async () => ({ channelId: mailChannel }),
    sendAuthEmail: (...args: unknown[]) => sendMail(...(args as []))
}));
vi.mock("@/lib/account-recovery-service", () => ({ unacceptablePassword: async () => unsafe }));

const service = await import("@/lib/admin-credentials-service");

beforeEach(() => {
    users = [
        {
            id: "admin-1",
            isAdmin: true,
            email: "root@example.com",
            emailVerified: true,
            name: "Root",
            passwordChangeRequired: false
        },
        {
            id: "admin-2",
            isAdmin: true,
            email: "ops@example.com",
            emailVerified: true,
            name: "Ops",
            passwordChangeRequired: false
        },
        {
            id: "user-1",
            isAdmin: false,
            email: "ada@example.com",
            emailVerified: true,
            name: "Ada",
            passwordChangeRequired: false
        }
    ];
    tickets = [];
    limited = false;
    mailChannel = null;
    unsafe = null;
    takenBy = null;
    audits.length = 0;
    vi.clearAllMocks();
});

describe("reset link", () => {
    it("stores only the hash of the ticket it hands out, approved and short-lived", async () => {
        const result = await service.issueResetLink("admin-1", "user-1");
        if ("error" in result) throw new Error(result.error);
        const ticket = new URL(result.url).searchParams.get("ticket")!;
        expect(result.url.startsWith("https://polaris.example/oauth/recover?ticket=")).toBe(true);
        expect(tickets).toHaveLength(1);
        expect(tickets[0].tokenHash).toBe(hashToken(ticket));
        expect(tickets[0].tokenHash).not.toContain(ticket);
        expect(tickets[0].status).toBe("approved");
        const minutes = (tickets[0].expiresAt.getTime() - Date.now()) / 60_000;
        expect(minutes).toBeGreaterThan(service.RESET_LINK_TTL_MINUTES - 1);
        expect(minutes).toBeLessThanOrEqual(service.RESET_LINK_TTL_MINUTES);
        expect(audits.map((entry) => entry.action)).toEqual(["user.password.reset-link"]);
        expect(JSON.stringify(audits)).not.toContain(ticket);
    });

    it("retires the previous link when a new one is issued", async () => {
        await service.issueResetLink("admin-1", "user-1");
        await service.issueResetLink("admin-1", "user-1");
        expect(tickets.map((row) => row.status)).toEqual(["expired", "approved"]);
    });

    it("refuses the caller's own account and one above theirs", async () => {
        users.find((u) => u.id === "admin-1")!.isAdmin = false;
        expect(await service.issueResetLink("admin-1", "admin-1")).toEqual({
            error: "usersDetail.errors.credentialsSelf"
        });
        expect(await service.issueResetLink("admin-1", "admin-2")).toEqual({
            error: "usersDetail.errors.outranked"
        });
        expect(tickets).toHaveLength(0);
    });

    it("stops once the attempts run out", async () => {
        limited = true;
        expect(await service.issueResetLink("admin-1", "user-1")).toEqual({
            error: "usersDetail.errors.tooMany"
        });
        expect(tickets).toHaveLength(0);
    });
});

describe("reset email", () => {
    it("is not offered, and refused, without an account mail channel", async () => {
        expect(await service.credentialOptions("user-1")).toEqual({ mailBlocker: "noChannel" });
        expect(await service.mailResetLink("admin-1", "user-1")).toEqual({
            error: "usersDetail.errors.mailNoChannel"
        });
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("is refused for an unconfirmed address", async () => {
        mailChannel = "channel-1";
        users.find((u) => u.id === "user-1")!.emailVerified = false;
        expect(await service.credentialOptions("user-1")).toEqual({ mailBlocker: "unverified" });
        expect(await service.mailResetLink("admin-1", "user-1")).toEqual({
            error: "usersDetail.errors.mailUnverified"
        });
    });

    it("names the account refusal before the mail one", async () => {
        expect(await service.mailResetLink("admin-1", "missing")).toEqual({
            error: "usersDetail.errors.unknownAccount"
        });
        expect(await service.mailResetLink("admin-1", "admin-1")).toEqual({
            error: "usersDetail.errors.credentialsSelf"
        });
    });

    it("mails the link to the account's own address when it can", async () => {
        mailChannel = "channel-1";
        expect(await service.mailResetLink("admin-1", "user-1")).toEqual({});
        expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com" }));
        expect(tickets).toHaveLength(1);
    });
});

describe("temporary password", () => {
    it("holds the account on the change step and ends every session", async () => {
        expect(
            await service.setTemporaryPassword("admin-1", "user-1", "correct horse battery")
        ).toEqual({});
        expect(resetPassword).toHaveBeenCalledWith({}, "user-1", "correct horse battery");
        expect(users.find((u) => u.id === "user-1")!.passwordChangeRequired).toBe(true);
        expect(revokeSessions).toHaveBeenCalledWith("admin-1", "user-1");
        expect(revokeGrants).toHaveBeenCalledWith("user-1");
        expect(JSON.stringify(audits)).not.toContain("correct horse battery");
    });

    it("refuses an unsafe password before writing anything", async () => {
        unsafe = "Pick a password that has not appeared in a data breach";
        expect(await service.setTemporaryPassword("admin-1", "user-1", "password123")).toEqual({
            error: unsafe
        });
        expect(resetPassword).not.toHaveBeenCalled();
    });

    it("is replaced by the account's own, which clears the hold and other sessions", async () => {
        await service.setTemporaryPassword("admin-1", "user-1", "correct horse battery");
        expect(await service.owesPasswordChange("user-1")).toBe(true);
        expect(
            await service.replaceTemporaryPassword("user-1", "session-9", "another long secret")
        ).toEqual({});
        expect(await service.owesPasswordChange("user-1")).toBe(false);
        expect(revokeOthers).toHaveBeenCalledWith("user-1", "session-9");
    });

    it("does nothing for an account that owes no change", async () => {
        expect(
            await service.replaceTemporaryPassword("user-1", "session-9", "another long secret")
        ).toEqual({});
        expect(resetPassword).not.toHaveBeenCalled();
    });
});

describe("change email", () => {
    it("refuses the address it already has and one another account holds", async () => {
        const input = { email: "ada@example.com", verified: false, keepOld: true };
        expect(await service.changeAccountEmail("admin-1", "user-1", input)).toEqual({
            error: "usersDetail.errors.emailUnchanged"
        });
        takenBy = "admin-2";
        expect(
            await service.changeAccountEmail("admin-1", "user-1", {
                ...input,
                email: "ops@example.com"
            })
        ).toEqual({
            error: "usersDetail.errors.emailTaken"
        });
    });

    it("moves the account, tells it in the bell, and records both addresses", async () => {
        const result = await service.changeAccountEmail("admin-1", "user-1", {
            email: "ada@new.example",
            verified: false,
            keepOld: false
        });
        expect(result).toEqual({});
        const user = users.find((u) => u.id === "user-1")!;
        expect(user.email).toBe("ada@new.example");
        expect(user.emailVerified).toBe(false);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "user-1", type: "account.email-changed" })
        );
        expect(audits[0]).toMatchObject({
            action: "user.email.change",
            metadata: { from: "ada@example.com", to: "ada@new.example" }
        });
    });
});

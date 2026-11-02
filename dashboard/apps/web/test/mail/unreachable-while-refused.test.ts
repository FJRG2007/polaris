/**
 * A server that cannot be reached says nothing about a credential. A refused
 * mailbox stays refused through it, and that attempt is never counted as the
 * server refusing it again, which is what would ring the bell about a password.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const row = vi.hoisted(() => ({
    id: "acc_1",
    userId: "usr_ana",
    state: "auth",
    stateDetail: "refused",
    lastSyncAt: null as Date | null,
    lastOkAt: new Date("2026-11-01T08:00:00Z"),
    createdAt: new Date("2026-01-01T08:00:00Z")
}));
const seen = vi.hoisted(() => ({ refusals: [] as string[], attempts: [] as string[], states: [] as string[] }));

vi.mock("imapflow", () => ({ ImapFlow: class {} }));
vi.mock("@/lib/audit-service", () => ({ audit: async () => undefined }));
vi.mock("@/lib/mailbox/live", () => ({ publishMail: () => undefined }));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null }));
vi.mock("@polaris/db", () => ({
    prisma: {
        mailAccount: { findUnique: async () => row },
        mailMessage: { findMany: async () => [], findFirst: async () => null }
    }
}));
vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: class MailAuthError extends Error {},
    mailCredential: async () => ({ kind: "password", username: "ana", password: "fixture" })
}));
vi.mock("@/lib/mailbox/refused", () => ({
    recordCredentialRefusal: async (id: string) => void seen.refusals.push(id)
}));
vi.mock("@/lib/mailbox/accounts", () => ({
    recordAccountAttempt: async (id: string) => void seen.attempts.push(id),
    recordAccountState: async (id: string, state: string) => void seen.states.push(`${id}:${state}`)
}));
vi.mock("@/lib/mailbox/imap", () => ({
    MailUnreachableError: class MailUnreachableError extends Error {},
    withImap: async () => {
        throw new Error("Connection timed out");
    }
}));

const { syncAccount } = await import("@/lib/mailbox/sync");

beforeEach(() => {
    seen.refusals = [];
    seen.attempts = [];
    seen.states = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a refused mailbox whose server cannot be reached", () => {
    it("stays refused, with the try written down and no refusal counted", async () => {
        await syncAccount(row.id, { force: true });
        expect(seen.refusals).toEqual([]);
        expect(seen.states).toEqual([]);
        expect(seen.attempts).toEqual([row.id]);
    });
});

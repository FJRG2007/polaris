/**
 * Changing a mailbox that is already connected.
 *
 * Until this existed a mailbox could be switched on and off and nothing else:
 * a new password, a moved server or a changed login meant removing it and adding
 * it again, and losing everything cached with it. The rules the edit keeps are
 * the ones adding one keeps, because the failure they prevent is the same - a
 * mailbox that silently stops syncing because of something typed on a form.
 *
 * - **Blank keeps the password.** Fixing a server name must not mean typing a
 *   password nobody remembers, and the stored one is what gets tried.
 * - **Nothing refused is stored.** A new password the server says no to comes
 *   back on the form, and the one that worked stays.
 * - **The address is not up for change.** It is what the mailbox is; a
 *   different one - including one already connected - is a different mailbox.
 * - **Renaming does not dial out.** Only a change to how it connects is tried
 *   against the servers.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const STORED = new Uint8Array([1, 2, 3]);

const state = {
    row: null as null | Record<string, unknown>,
    tried: [] as Record<string, unknown>[],
    refuse: "" as "" | "imap" | "smtp",
    written: [] as Record<string, unknown>[],
    synced: [] as { id: string; force: boolean }[],
    audited: [] as Record<string, unknown>[]
};

class FakeAuthError extends Error {}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailAccount: {
            update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                state.written.push(data);
                Object.assign(state.row ?? {}, data);
                return state.row;
            })
        },
        userConnection: {
            findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
                where.id === "0190c1d2-0000-7000-8000-0000000000c1"
                    ? { id: where.id, provider: "google", scope: "mail" }
                    : null
            )
        }
    }
}));
vi.mock("@/lib/mailbox/access", () => ({
    ownedAccount: async (userId: string, accountId: string) => {
        if (!state.row || userId !== "usr_ana" || accountId !== state.row.id) {
            throw new Error("not yours");
        }
        return { ...state.row };
    },
    ownedAccounts: async () => []
}));
vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: FakeAuthError,
    grantsMailAccess: () => true,
    sealMailSecret: (secret: string) => ({
        encryptedSecret: new TextEncoder().encode(`sealed:${secret}`),
        secretNonce: new Uint8Array([9]),
        secretKeyId: "k2"
    })
}));
vi.mock("@/lib/mailbox/imap", () => ({
    checkImap: async (candidate: Record<string, unknown>) => {
        state.tried.push({ ...candidate, server: "imap" });
        if (state.refuse === "imap") {
            throw new FakeAuthError("The mail server refused this account's credentials.");
        }
    }
}));
vi.mock("@/lib/mailbox/send", () => ({
    checkSmtp: async (candidate: Record<string, unknown>) => {
        state.tried.push({ ...candidate, server: "smtp" });
        if (state.refuse === "smtp") throw new Error("connect ECONNREFUSED");
    }
}));
vi.mock("@/lib/mailbox/sync", () => ({
    syncAccount: async (id: string, options: { force?: boolean } = {}) => {
        state.synced.push({ id, force: options.force === true });
    }
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: Record<string, unknown>) => {
        state.audited.push(entry);
    }
}));

const { MailSetupError, updateAccount } = await import("@/lib/mailbox/accounts");

const ID = "0190c1d2-0000-7000-8000-000000000001";

function stored(overrides: Record<string, unknown> = {}) {
    state.row = {
        id: ID,
        userId: "usr_ana",
        orgId: null,
        address: "ana@example.com",
        displayName: "Ana",
        label: "",
        color: null,
        service: "",
        auth: "password",
        connectionId: null,
        username: "",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecurity: "tls",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        encryptedSecret: STORED,
        secretNonce: new Uint8Array([7]),
        secretKeyId: "k1",
        state: "ok",
        stateDetail: "",
        lastSyncAt: null,
        lastOkAt: null,
        createdAt: new Date("2026-09-01T00:00:00Z"),
        ...overrides
    };
    return state.row;
}

/** What the edit form sends, read through the same schema the action uses. */
function edit(input: Record<string, unknown>) {
    return core.mailAccountUpdateSchema.parse({
        displayName: "Ana",
        label: "",
        color: null,
        auth: "password",
        password: "",
        username: "",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 465, security: "tls" },
        ...input
    });
}

beforeEach(() => {
    state.row = null;
    state.tried = [];
    state.refuse = "";
    state.written = [];
    state.synced = [];
    state.audited = [];
});

describe("changing a connected mailbox", () => {
    it("keeps the stored password when the box is left blank, and tries that one", async () => {
        stored();
        await updateAccount("usr_ana", ID, edit({ imap: { host: "mail.example.com", port: 993, security: "tls" } }));

        expect(state.tried.map((one) => one.server)).toEqual(["imap", "smtp"]);
        expect(state.tried[0]?.encryptedSecret).toBe(STORED);
        expect(state.tried[0]?.imapHost).toBe("mail.example.com");
        const written = state.written[0] ?? {};
        expect(written.imapHost).toBe("mail.example.com");
        // The same bytes are not written back over themselves.
        expect("encryptedSecret" in written).toBe(false);
        expect(state.audited[0]?.metadata).toMatchObject({ credential: "kept" });
    });

    it("stores a new password only once both servers take it", async () => {
        stored({ state: "auth", stateDetail: "The mail server refused this account's credentials." });
        await updateAccount("usr_ana", ID, edit({ password: "new-secret" }));

        const written = state.written[0] ?? {};
        expect(new TextDecoder().decode(written.encryptedSecret as Uint8Array)).toBe("sealed:new-secret");
        expect(written.state).toBe("ok");
        expect(written.stateDetail).toBe("");
        // Picked up at once rather than on the next tick.
        expect(state.synced).toEqual([{ id: ID, force: true }]);
        // Never the password itself, anywhere it could be read back.
        expect(JSON.stringify(state.audited)).not.toContain("new-secret");
    });

    it("refuses a password the server refuses, on the password box, and stores nothing", async () => {
        stored();
        state.refuse = "imap";
        const attempt = updateAccount("usr_ana", ID, edit({ password: "wrong" }));
        await expect(attempt).rejects.toBeInstanceOf(MailSetupError);
        await expect(attempt).rejects.toMatchObject({ field: "password" });
        expect(state.written).toHaveLength(0);
        expect(state.synced).toHaveLength(0);
    });

    it("refuses a server it cannot reach, on that server, and stores nothing", async () => {
        stored();
        state.refuse = "smtp";
        const attempt = updateAccount("usr_ana", ID, edit({ password: "new-secret" }));
        await expect(attempt).rejects.toMatchObject({ field: "smtpHost" });
        expect(state.written).toHaveLength(0);
    });

    it("does not treat a blank box as a kept password when there is none to keep", async () => {
        stored({ auth: "oauth", connectionId: "c9", encryptedSecret: null, secretNonce: null });
        const attempt = updateAccount("usr_ana", ID, edit({ password: "" }));
        await expect(attempt).rejects.toMatchObject({ field: "password" });
        expect(state.tried).toHaveLength(0);
    });

    it("renames without asking the servers anything", async () => {
        stored();
        await updateAccount("usr_ana", ID, edit({ label: "  Work  ", displayName: "Ana  Pérez" }));
        expect(state.tried).toHaveLength(0);
        expect(state.written).toEqual([{ displayName: "Ana Pérez", label: "Work", color: null }]);
    });

    it("never moves the mailbox to another address, taken or not", async () => {
        stored();
        const parsed = core.mailAccountUpdateSchema.parse({
            ...edit({ password: "new-secret" }),
            address: "someone-else@example.com"
        });
        expect("address" in parsed).toBe(false);
        await updateAccount("usr_ana", ID, parsed);
        expect(state.tried[0]?.address).toBe("ana@example.com");
        expect(state.written[0]?.address).toBeUndefined();
    });

    it("moves an authorized mailbox to a link that can read mail", async () => {
        stored({ auth: "oauth", connectionId: null, encryptedSecret: null, secretNonce: null, service: "gmail" });
        await updateAccount(
            "usr_ana",
            ID,
            edit({ auth: "oauth", connectionId: "0190c1d2-0000-7000-8000-0000000000c1" })
        );
        expect(state.written[0]?.connectionId).toBe("0190c1d2-0000-7000-8000-0000000000c1");
        expect(state.written[0]?.encryptedSecret).toBeNull();
    });

    it("is refused for a mailbox that is not the caller's", async () => {
        stored();
        await expect(updateAccount("usr_eve", ID, edit({ password: "x" }))).rejects.toThrow("not yours");
        expect(state.tried).toHaveLength(0);
    });
});

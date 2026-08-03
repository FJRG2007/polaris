/**
 * The note a sign-in leaves for the session it is about to open.
 *
 * A sign-in is answered in one request, the session's own row is written in
 * another, and a second factor puts one or two more in between. Each of them
 * knows one piece of how the account proved itself and none of them knows all of
 * it, so the pieces are left on the account and collected once at the end.
 *
 * Everything that can go wrong with that is about the seam:
 *
 *   - answering the challenge must not lose the first factor, because the request
 *     that carries the code carries nothing about the password;
 *   - the channel a code went out on is only known where it was sent, so checking
 *     the code must keep it rather than overwrite it with a generic answer;
 *   - a note is spent by exactly one session, or a second sign-in would inherit
 *     the first one's description;
 *   - an abandoned sign-in must expire unread rather than label whatever session
 *     turns up next.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-1111-1111-111111111111";

interface SecurityRow {
    userId: string;
    pendingSignInMethod: string | null;
    pendingSignInFactor: string | null;
    pendingSignInAt: Date | null;
}

let rows: SecurityRow[] = [];

function blank(userId: string): SecurityRow {
    return { userId, pendingSignInMethod: null, pendingSignInFactor: null, pendingSignInAt: null };
}

/** Enough of Prisma to hold the one row these functions touch. Reads hand back a
 *  copy, the way a real query does: this code reads the note and then clears it,
 *  and a live reference would quietly make that read see its own erasure. */
const prisma = {
    userSecurity: {
        findUnique: async ({ where }: { where: { userId: string } }) => {
            const row = rows.find((entry) => entry.userId === where.userId);
            return row ? { ...row } : null;
        },
        update: async ({ where, data }: { where: { userId: string }; data: Partial<SecurityRow> }) => {
            const row = rows.find((entry) => entry.userId === where.userId);
            if (!row) throw new Error("no such account");
            Object.assign(row, data);
            return row;
        },
        upsert: async ({
            where,
            create,
            update
        }: {
            where: { userId: string };
            create: Partial<SecurityRow>;
            update: Partial<SecurityRow>;
        }) => {
            const row = rows.find((entry) => entry.userId === where.userId);
            if (row) {
                Object.assign(row, update);
                return row;
            }
            const created = { ...blank(where.userId), ...create };
            rows.push(created);
            return created;
        }
    }
};

vi.mock("@polaris/db", () => ({ prisma }));

const { carrySignInRecord, noteSecondFactor, noteSentCodeAnswered, noteSignIn, takeSignInRecord } = await import(
    "../../src/sign-in-record.js"
);

beforeEach(() => {
    rows = [];
});

describe("a sign-in with nothing on top of it", () => {
    it("is collected by the session it opened", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: null });
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: null });
    });

    it("is spent once, so a second session is not described as the first", async () => {
        await noteSignIn(USER, { method: "passkey", secondFactor: null });
        await takeSignInRecord(USER);
        expect(await takeSignInRecord(USER)).toEqual({ method: null, secondFactor: null });
    });

    it("reads as nothing for an account that has never signed in here", async () => {
        expect(await takeSignInRecord(USER)).toEqual({ method: null, secondFactor: null });
    });
});

describe("a sign-in that answered a challenge", () => {
    it("keeps the first factor the code request knew nothing about", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: "trusted-device" });
        await noteSecondFactor(USER, "totp");
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "totp" });
    });

    it("records the spare key for what it is", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: "trusted-device" });
        await noteSecondFactor(USER, "backup-code");
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "backup-code" });
    });
});

describe("a sent code", () => {
    it("is remembered by the channel it went out on, not by the request that checked it", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: "trusted-device" });
        await noteSecondFactor(USER, "whatsapp-code");
        await noteSentCodeAnswered(USER);
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "whatsapp-code" });
    });

    it("still says a code was answered when no channel was recorded", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: "trusted-device" });
        await noteSentCodeAnswered(USER);
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "code" });
    });
});

describe("a sign-in nobody finished", () => {
    it("expires unread rather than labelling whatever session turns up next", async () => {
        await noteSignIn(USER, { method: "email-link", secondFactor: null });
        const row = rows[0];
        if (row) row.pendingSignInAt = new Date(Date.now() - 60 * 60 * 1000);
        expect(await takeSignInRecord(USER)).toEqual({ method: null, secondFactor: null });
    });

    it("is cleared even when it was too old to use, so it cannot be read twice", async () => {
        await noteSignIn(USER, { method: "email-link", secondFactor: null });
        const row = rows[0];
        if (row) row.pendingSignInAt = new Date(Date.now() - 60 * 60 * 1000);
        await takeSignInRecord(USER);
        expect(rows[0]?.pendingSignInMethod).toBeNull();
    });
});

describe("a session being replaced", () => {
    it("hands its record to the one that continues it", async () => {
        await carrySignInRecord(USER, { method: "password", secondFactor: "totp" });
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "totp" });
    });

    it("hands on nothing when it had nothing to hand on", async () => {
        await carrySignInRecord(USER, { method: null, secondFactor: null });
        expect(rows).toHaveLength(0);
    });
});

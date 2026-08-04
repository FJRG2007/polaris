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
 *     turns up next;
 *   - the device that answered for a scanned code is half a note written by yet
 *     another request, and it belongs to that sign-in alone - a half left behind
 *     by an approval nobody came back for must not name the device that answered
 *     it on whatever signs in next.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-1111-1111-111111111111";
/** The session that scanned a code and allowed the sign-in behind it. */
const PHONE = "22222222-2222-2222-2222-222222222222";

interface SecurityRow {
    userId: string;
    pendingSignInMethod: string | null;
    pendingSignInFactor: string | null;
    pendingSignInAt: Date | null;
    pendingAuthorizerId: string | null;
    pendingAuthorizerDevice: string | null;
}

let rows: SecurityRow[] = [];

function blank(userId: string): SecurityRow {
    return {
        userId,
        pendingSignInMethod: null,
        pendingSignInFactor: null,
        pendingSignInAt: null,
        pendingAuthorizerId: null,
        pendingAuthorizerDevice: null
    };
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

const { carrySignInRecord, noteSecondFactor, noteSentCodeAnswered, noteSignIn, noteSignInAuthorizer, takeSignInRecord } =
    await import("../../src/sign-in-record.js");

beforeEach(() => {
    rows = [];
});

describe("a sign-in with nothing on top of it", () => {
    it("is collected by the session it opened", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: null });
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: null, authorizedBy: null });
    });

    it("is spent once, so a second session is not described as the first", async () => {
        await noteSignIn(USER, { method: "passkey", secondFactor: null });
        await takeSignInRecord(USER);
        expect(await takeSignInRecord(USER)).toEqual({ method: null, secondFactor: null, authorizedBy: null });
    });

    it("reads as nothing for an account that has never signed in here", async () => {
        expect(await takeSignInRecord(USER)).toEqual({ method: null, secondFactor: null, authorizedBy: null });
    });
});

describe("a sign-in that answered a challenge", () => {
    it("keeps the first factor the code request knew nothing about", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: "trusted-device" });
        await noteSecondFactor(USER, "totp");
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "totp", authorizedBy: null });
    });

    it("records the spare key for what it is", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: "trusted-device" });
        await noteSecondFactor(USER, "backup-code");
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "backup-code", authorizedBy: null });
    });
});

describe("a sent code", () => {
    it("is remembered by the channel it went out on, not by the request that checked it", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: "trusted-device" });
        await noteSecondFactor(USER, "whatsapp-code");
        await noteSentCodeAnswered(USER);
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "whatsapp-code", authorizedBy: null });
    });

    it("still says a code was answered when no channel was recorded", async () => {
        await noteSignIn(USER, { method: "password", secondFactor: "trusted-device" });
        await noteSentCodeAnswered(USER);
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "code", authorizedBy: null });
    });
});

describe("a sign-in nobody finished", () => {
    it("expires unread rather than labelling whatever session turns up next", async () => {
        await noteSignIn(USER, { method: "email-link", secondFactor: null });
        const row = rows[0];
        if (row) row.pendingSignInAt = new Date(Date.now() - 60 * 60 * 1000);
        expect(await takeSignInRecord(USER)).toEqual({ method: null, secondFactor: null, authorizedBy: null });
    });

    it("is cleared even when it was too old to use, so it cannot be read twice", async () => {
        await noteSignIn(USER, { method: "email-link", secondFactor: null });
        const row = rows[0];
        if (row) row.pendingSignInAt = new Date(Date.now() - 60 * 60 * 1000);
        await takeSignInRecord(USER);
        expect(rows[0]?.pendingSignInMethod).toBeNull();
    });
});

describe("a scanned code somebody answered", () => {
    it("hands the answering device to the session that code opens", async () => {
        await noteSignInAuthorizer(USER, { sessionId: PHONE, device: "Safari on iOS" });
        await noteSignIn(USER, { method: "qr-code", secondFactor: null });
        expect(await takeSignInRecord(USER)).toEqual({
            method: "qr-code",
            secondFactor: null,
            authorizedBy: { sessionId: PHONE, device: "Safari on iOS" }
        });
    });

    it("says the device is unknown rather than dropping an answer it has no label for", async () => {
        await noteSignInAuthorizer(USER, { sessionId: PHONE, device: "Safari on iOS" });
        await noteSignIn(USER, { method: "qr-code", secondFactor: null });
        const row = rows[0];
        if (row) row.pendingAuthorizerDevice = null;
        expect((await takeSignInRecord(USER)).authorizedBy).toEqual({ sessionId: PHONE, device: "Unknown device" });
    });

    // The approval and the sign-in it allows are different requests, so a browser
    // that never came back leaves the answering device behind on the account.
    it("does not name the answering device on a sign-in that was not the scanned one", async () => {
        await noteSignInAuthorizer(USER, { sessionId: PHONE, device: "Safari on iOS" });
        await noteSignIn(USER, { method: "password", secondFactor: null });
        expect((await takeSignInRecord(USER)).authorizedBy).toBeNull();
    });

    it("does not name it on a session nothing noted a sign-in for at all", async () => {
        await noteSignInAuthorizer(USER, { sessionId: PHONE, device: "Safari on iOS" });
        expect((await takeSignInRecord(USER)).authorizedBy).toBeNull();
    });

    it("is spent once, so the next scanned code is not answered by the last one's device", async () => {
        await noteSignInAuthorizer(USER, { sessionId: PHONE, device: "Safari on iOS" });
        await noteSignIn(USER, { method: "qr-code", secondFactor: null });
        await takeSignInRecord(USER);
        await noteSignIn(USER, { method: "qr-code", secondFactor: null });
        expect((await takeSignInRecord(USER)).authorizedBy).toBeNull();
    });
});

describe("a session being replaced", () => {
    it("hands its record to the one that continues it", async () => {
        await carrySignInRecord(USER, { method: "password", secondFactor: "totp" });
        expect(await takeSignInRecord(USER)).toEqual({ method: "password", secondFactor: "totp", authorizedBy: null });
    });

    it("hands on nothing when it had nothing to hand on", async () => {
        await carrySignInRecord(USER, { method: null, secondFactor: null });
        expect(rows).toHaveLength(0);
    });

    // The carried method is whatever the session signed in with, so a session
    // that got in by scanned code hands "qr-code" on - which is exactly what an
    // approval nobody came back for is waiting to pair with.
    it("answers for nobody, so a left-behind approval does not label the replacement", async () => {
        await noteSignInAuthorizer(USER, { sessionId: PHONE, device: "Safari on iOS" });
        await carrySignInRecord(USER, { method: "qr-code", secondFactor: null });
        expect(await takeSignInRecord(USER)).toEqual({ method: "qr-code", secondFactor: null, authorizedBy: null });
    });
});

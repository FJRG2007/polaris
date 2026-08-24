/**
 * The two minutes a proof is good for.
 *
 * The window exists because a gate that fires per switch is a gate people stop
 * reading by the third press - so asking once and meaning it is the stronger
 * arrangement in practice. That argument only holds while the window is actually
 * narrow, which is what this file is about.
 *
 * Three properties, and losing any one of them turns the convenience into the
 * hole it was meant to avoid: it belongs to one session, it belongs to one
 * purpose, and it is spent by the clock rather than renewed by use.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    userId: string;
    sessionId: string;
    purpose: string;
    expiresAt: Date;
}

/** The table, keyed the way the unique index keys it. */
let rows = new Map<string, Row>();
const key = (sessionId: string, purpose: string) => `${sessionId}/${purpose}`;

vi.mock("@polaris/db", () => ({
    prisma: {
        stepUpGrant: {
            upsert: async (args: {
                where: { sessionId_purpose: { sessionId: string; purpose: string } };
                create: Row;
            }) => {
                const at = args.where.sessionId_purpose;
                rows.set(key(at.sessionId, at.purpose), { ...args.create });
                return args.create;
            },
            findUnique: async (args: {
                where: { sessionId_purpose: { sessionId: string; purpose: string } };
            }) => {
                const at = args.where.sessionId_purpose;
                return rows.get(key(at.sessionId, at.purpose)) ?? null;
            },
            deleteMany: async (args: { where: { userId?: string; expiresAt?: { lt: Date } } }) => {
                let count = 0;
                for (const [id, row] of [...rows]) {
                    const byUser = args.where.userId !== undefined && row.userId === args.where.userId;
                    const byTime =
                        args.where.expiresAt !== undefined &&
                        row.expiresAt.getTime() < args.where.expiresAt.lt.getTime();
                    if (byUser || byTime) {
                        rows.delete(id);
                        count += 1;
                    }
                }
                return { count };
            }
        }
    }
}));

const grants = await import("@/lib/step-up-grant");

beforeEach(() => {
    rows = new Map();
    vi.useRealTimers();
});

describe("a proof just given", () => {
    it("is good for this session and this purpose", async () => {
        await grants.grantStepUp("ada", "s1", "connected-sign-in");
        expect(await grants.stepUpGranted("ada", "s1", "connected-sign-in")).toBe(true);
    });

    it("is not a proof on another device", async () => {
        // The whole value of the gate is that it is not the open session, and a
        // grant that travelled between sessions would be exactly that.
        await grants.grantStepUp("ada", "s1", "connected-sign-in");
        expect(await grants.stepUpGranted("ada", "s2", "connected-sign-in")).toBe(false);
    });

    it("is not a proof for anything else", async () => {
        await grants.grantStepUp("ada", "s1", "connected-sign-in");
        expect(await grants.stepUpGranted("ada", "s1", "lockdown")).toBe(false);
        expect(await grants.stepUpGranted("ada", "s1", "close-account")).toBe(false);
    });

    it("is not a proof for another account holding the same session id", async () => {
        // They should never disagree. The check is here because the row outlives
        // nothing else and a lookup that trusted the session alone would be one
        // rotation away from being wrong.
        await grants.grantStepUp("ada", "s1", "lockdown");
        expect(await grants.stepUpGranted("grace", "s1", "lockdown")).toBe(false);
    });
});

describe("the clock", () => {
    it("runs out, and the grant with it", async () => {
        vi.useFakeTimers({ now: new Date("2026-01-01T12:00:00Z") });
        await grants.grantStepUp("ada", "s1", "lockdown");
        expect(await grants.stepUpGranted("ada", "s1", "lockdown")).toBe(true);

        vi.advanceTimersByTime(grants.STEP_UP_GRANT_MS + 1);
        expect(await grants.stepUpGranted("ada", "s1", "lockdown")).toBe(false);
    });

    it("is not renewed by using the grant", async () => {
        // A window that extended itself on every use would be an open door for as
        // long as somebody kept the tab busy.
        vi.useFakeTimers({ now: new Date("2026-01-01T12:00:00Z") });
        await grants.grantStepUp("ada", "s1", "lockdown");
        vi.advanceTimersByTime(grants.STEP_UP_GRANT_MS - 1000);
        expect(await grants.stepUpGranted("ada", "s1", "lockdown")).toBe(true);
        vi.advanceTimersByTime(2000);
        expect(await grants.stepUpGranted("ada", "s1", "lockdown")).toBe(false);
    });

    it("is two minutes and not longer", async () => {
        // Stated as a number so a change to it is a change somebody made on
        // purpose rather than a constant that drifted.
        expect(grants.STEP_UP_GRANT_MS).toBe(2 * 60 * 1000);
    });
});

describe("when the ground moves", () => {
    it("drops everything the account was holding", async () => {
        // Raising a lockdown, changing a password: a proof given before that
        // moment was a proof about a different situation.
        await grants.grantStepUp("ada", "s1", "connected-sign-in");
        await grants.grantStepUp("ada", "s2", "lockdown");
        await grants.grantStepUp("grace", "s3", "lockdown");

        await grants.revokeStepUpGrants("ada");
        expect(await grants.stepUpGranted("ada", "s1", "connected-sign-in")).toBe(false);
        expect(await grants.stepUpGranted("ada", "s2", "lockdown")).toBe(false);
        // And leaves everybody else alone.
        expect(await grants.stepUpGranted("grace", "s3", "lockdown")).toBe(true);
    });
});

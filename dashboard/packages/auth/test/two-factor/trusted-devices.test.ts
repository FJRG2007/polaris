/**
 * Remembered devices - the browsers allowed to sign in without answering the
 * challenge for thirty days.
 *
 * The pass is better-auth's: a verification row keyed by a random identifier,
 * rotated every time it is spent. Polaris keeps a description beside it so the
 * account can list its devices and end one of them, and everything that can go
 * wrong with that arrangement is about the seam between the two:
 *
 *   - a pass with no description must still be listed, or the page would show a
 *     shorter list than the truth and a device nobody can name is exactly the
 *     one somebody wants to end;
 *   - a description must follow the rotation, or a device loses its name the
 *     first time it is used, which is to say immediately;
 *   - ending a pass must end the description with it, and must never reach
 *     another account's;
 *   - "this device" is read off a signed cookie, so a forged one must not be
 *     able to make the page point at the wrong row.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-secret-value-0123456789";
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

interface VerificationRow {
    identifier: string;
    value: string;
    expiresAt: Date;
    createdAt: Date;
}

interface DeviceRow {
    identifier: string;
    userId: string;
    userAgent: string | null;
    ip: string | null;
    host: string | null;
    createdAt: Date;
    lastSeenAt: Date;
}

let verifications: VerificationRow[] = [];
let devices: DeviceRow[] = [];

/** Enough of Prisma to hold the two tables in memory, in the shapes these
 *  functions actually query them with. */
const prisma = {
    verification: {
        count: async ({ where }: { where: Record<string, unknown> }) => matchPasses(where).length,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
            matchPasses(where).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
            matchPasses(where).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
            const doomed = matchPasses(where);
            verifications = verifications.filter((row) => !doomed.includes(row));
            return { count: doomed.length };
        }
    },
    trustedDevice: {
        findMany: async ({ where }: { where: { userId: string; identifier: { in: string[] } } }) =>
            devices.filter((row) => row.userId === where.userId && where.identifier.in.includes(row.identifier)),
        findUnique: async ({ where }: { where: { identifier: string } }) =>
            devices.find((row) => row.identifier === where.identifier) ?? null,
        update: async ({ where, data }: { where: { identifier: string }; data: Partial<DeviceRow> }) => {
            const row = devices.find((entry) => entry.identifier === where.identifier);
            if (!row) throw new Error("no such device");
            Object.assign(row, data);
            return row;
        },
        upsert: async ({
            where,
            create,
            update
        }: {
            where: { identifier: string };
            create: DeviceRow;
            update: Partial<DeviceRow>;
        }) => {
            const row = devices.find((entry) => entry.identifier === where.identifier);
            if (row) {
                Object.assign(row, update);
                return row;
            }
            const created = { createdAt: new Date(), lastSeenAt: new Date(), ...create };
            devices.push(created);
            return created;
        },
        deleteMany: async ({ where }: { where: { userId: string; identifier?: string } }) => {
            const before = devices.length;
            devices = devices.filter(
                (row) =>
                    !(row.userId === where.userId && (where.identifier === undefined || row.identifier === where.identifier))
            );
            return { count: before - devices.length };
        }
    }
};

/** The one filter shape these functions build: a `trust-device-*` identifier for
 *  a user, sometimes narrowed to one identifier or to the unexpired. */
function matchPasses(where: Record<string, unknown>): VerificationRow[] {
    const identifier = where.identifier as { startsWith?: string } | string | undefined;
    const startsWith = typeof identifier === "object" ? identifier.startsWith : undefined;
    const exact = typeof identifier === "string" ? identifier : undefined;
    const expires = where.expiresAt as { gt?: Date } | undefined;
    return verifications.filter(
        (row) =>
            row.value === where.value &&
            (startsWith === undefined || row.identifier.startsWith(startsWith)) &&
            (exact === undefined || row.identifier === exact) &&
            (expires?.gt === undefined || row.expiresAt > expires.gt)
    );
}

vi.mock("@polaris/db", () => ({ prisma }));

type TwoFactorModule = typeof import("../../src/two-factor.js");
let twoFactor: TwoFactorModule;

beforeAll(async () => {
    process.env.POLARIS_DATABASE_URL = "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
    process.env.POLARIS_AUTH_SECRET = SECRET;
    process.env.POLARIS_MASTER_KEY = Buffer.alloc(32).toString("base64");
    process.env.POLARIS_APP_URL = "https://polaris.example.com";
    process.env.POLARIS_LOCAL_HOSTNAME = "polaris";
    twoFactor = await import("../../src/two-factor.js");
});

/** A pass, as better-auth writes one. */
function pass(identifier: string, userId = USER, minutesAgo = 0): void {
    verifications.push({
        identifier,
        value: userId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - minutesAgo * 60 * 1000)
    });
}

beforeEach(() => {
    verifications = [];
    devices = [];
});

describe("listing what an account has remembered", () => {
    it("names a device Polaris described, and still lists one it did not", async () => {
        pass("trust-device-aaa", USER, 5);
        pass("trust-device-bbb", USER, 1);
        await twoFactor.recordTrustedDevice(USER, { userAgent: "Firefox/1", ip: "10.0.0.9", host: "polaris.local" });

        const listed = await twoFactor.listTrustedDevices(USER, null);
        expect(listed.map((device) => device.id)).toEqual(["trust-device-bbb", "trust-device-aaa"]);
        // The newest pass is the one just described; the older one predates the
        // description and has to survive the join rather than disappear from it.
        expect(listed[0]?.userAgent).toBe("Firefox/1");
        expect(listed[1]?.userAgent).toBeNull();
        expect(listed[1]?.rememberedAt).toBeNull();
    });

    it("leaves a pass that has run out off the list", async () => {
        pass("trust-device-live");
        verifications.push({
            identifier: "trust-device-dead",
            value: USER,
            expiresAt: new Date(Date.now() - 1000),
            createdAt: new Date(Date.now() - 60 * 60 * 1000)
        });
        const listed = await twoFactor.listTrustedDevices(USER, null);
        expect(listed.map((device) => device.id)).toEqual(["trust-device-live"]);
    });

    it("never shows one account another's devices", async () => {
        pass("trust-device-theirs", OTHER);
        expect(await twoFactor.listTrustedDevices(USER, null)).toEqual([]);
        expect(await twoFactor.countTrustedDevices(USER)).toBe(0);
    });

    it("flags the pass the browser asking is holding", async () => {
        pass("trust-device-aaa");
        pass("trust-device-bbb");
        const listed = await twoFactor.listTrustedDevices(USER, "trust-device-aaa");
        expect(listed.find((device) => device.id === "trust-device-aaa")?.current).toBe(true);
        expect(listed.find((device) => device.id === "trust-device-bbb")?.current).toBe(false);
    });
});

describe("a pass better-auth rotated", () => {
    it("keeps the description on the device rather than the identifier", async () => {
        pass("trust-device-old");
        await twoFactor.recordTrustedDevice(USER, { userAgent: "Firefox/1", ip: "10.0.0.9" });

        // What better-auth does on a sign-in the pass admits: the old row goes,
        // a new one takes its place.
        verifications = [];
        pass("trust-device-new");
        await twoFactor.followTrustedDevice(USER, "trust-device-old", { userAgent: "Firefox/2", ip: "10.0.0.10" });

        const listed = await twoFactor.listTrustedDevices(USER, null);
        expect(listed).toHaveLength(1);
        expect(listed[0]?.id).toBe("trust-device-new");
        expect(listed[0]?.userAgent).toBe("Firefox/2");
        expect(devices).toHaveLength(1);
    });

    it("describes a device that was remembered before Polaris kept descriptions", async () => {
        verifications = [];
        pass("trust-device-new");
        await twoFactor.followTrustedDevice(USER, "trust-device-nameless", { userAgent: "Safari/1" });
        const listed = await twoFactor.listTrustedDevices(USER, null);
        expect(listed[0]?.userAgent).toBe("Safari/1");
    });

    it("drops the description when the pass was refused rather than rotated", async () => {
        pass("trust-device-old");
        await twoFactor.recordTrustedDevice(USER, { userAgent: "Firefox/1" });
        verifications = [];
        await twoFactor.followTrustedDevice(USER, "trust-device-old", {});
        expect(devices).toEqual([]);
    });
});

describe("ending a pass", () => {
    it("takes the description with it and leaves the others alone", async () => {
        pass("trust-device-keep", USER, 5);
        pass("trust-device-drop", USER, 1);
        await twoFactor.recordTrustedDevice(USER, { userAgent: "Firefox/1" });

        expect(await twoFactor.revokeTrustedDevice(USER, "trust-device-drop")).toBe(true);
        expect(devices).toEqual([]);
        expect((await twoFactor.listTrustedDevices(USER, null)).map((device) => device.id)).toEqual([
            "trust-device-keep"
        ]);
    });

    it("refuses a handle belonging to another account", async () => {
        pass("trust-device-theirs", OTHER);
        expect(await twoFactor.revokeTrustedDevice(USER, "trust-device-theirs")).toBe(false);
        expect(await twoFactor.countTrustedDevices(OTHER)).toBe(1);
    });

    it("refuses anything that is not a pass at all", async () => {
        pass("trust-device-mine");
        expect(await twoFactor.revokeTrustedDevice(USER, "2fa-attempts-something")).toBe(false);
        expect(await twoFactor.countTrustedDevices(USER)).toBe(1);
    });

    it("ends every pass and every description when asked for all of them", async () => {
        pass("trust-device-a", USER, 2);
        await twoFactor.recordTrustedDevice(USER, { userAgent: "Firefox/1" });
        pass("trust-device-b", USER, 1);
        await twoFactor.recordTrustedDevice(USER, { userAgent: "Safari/1" });
        pass("trust-device-theirs", OTHER);

        expect(await twoFactor.revokeTrustedDevices(USER)).toBe(2);
        expect(devices).toEqual([]);
        expect(await twoFactor.countTrustedDevices(OTHER)).toBe(1);
    });
});

describe("which pass this browser is holding", () => {
    /** The cookie better-auth hands a remembered browser: an HMAC over the user
     *  and the identifier, then the identifier, then better-call's signature. */
    async function cookieFor(userId: string, identifier: string): Promise<string> {
        const { createHmac } = await import("node:crypto");
        const token = createHmac("sha256", SECRET).update(`${userId}!${identifier}`).digest("base64url");
        return `${token}!${identifier}.${"s".repeat(43)}=`;
    }

    it("reads the identifier out of a cookie this instance signed", async () => {
        const cookie = await cookieFor(USER, "trust-device-aaa");
        expect(twoFactor.currentTrustedDevice(cookie, USER)).toBe("trust-device-aaa");
    });

    it("refuses one signed for a different account", async () => {
        const cookie = await cookieFor(OTHER, "trust-device-aaa");
        expect(twoFactor.currentTrustedDevice(cookie, USER)).toBeNull();
    });

    it("refuses one whose identifier was swapped under the token", async () => {
        const cookie = await cookieFor(USER, "trust-device-aaa");
        expect(twoFactor.currentTrustedDevice(cookie.replace("aaa", "bbb"), USER)).toBeNull();
    });

    it("refuses a made-up one, and copes with no cookie at all", async () => {
        expect(twoFactor.currentTrustedDevice("nonsense!trust-device-aaa.sig", USER)).toBeNull();
        expect(twoFactor.currentTrustedDevice(undefined, USER)).toBeNull();
        expect(twoFactor.currentTrustedDevice("", USER)).toBeNull();
    });
});

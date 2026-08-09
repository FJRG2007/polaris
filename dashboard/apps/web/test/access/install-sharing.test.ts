/**
 * What somebody may hand out when they share a server they run.
 *
 * This is the boundary that makes delegation safe to switch on at all: the person
 * sharing is not an administrator, and the dialog they are using is a client
 * component. So none of the bounds may live there. Each case below drives the
 * service directly with a dialog that has asked for more than it should.
 */

import type { Permission } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";

/** What the sharer holds on this server, and how far they may pass it on. */
let held: Permission[] = [];
let mayPassOn = true;
let until: Date | null = null;
let isOwner = true;
let isAdmin = false;
let mode: "off" | "existing" | "invite" = "existing";
/** The account the identifier resolves to, or none for an unknown address. */
let target: { id: string; name: string } | null = null;

let written: Record<string, unknown> | null = null;
let invited: Record<string, unknown> | null = null;

vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) }));
vi.mock("@/lib/invite-service", () => ({
    createInvite: async (invitedById: string, input: Record<string, unknown>) => {
        invited = { invitedById, ...input };
        return { id: "invite-1", url: "https://polaris.example/oauth/accept-invite?token=x" };
    }
}));
vi.mock("@/lib/sharing-policy", () => ({
    sharingPolicy: async () => ({ delegated: mode, inviteRole: "guest", inviteDays: 7 }),
    canDelegateShare: async (input: { isAdmin: boolean; mayPassOn: boolean; toStranger?: boolean }) => {
        if (input.isAdmin) return { ok: true };
        if (!input.mayPassOn) return { ok: false, reason: "You cannot give other people access to this" };
        if (mode === "off") return { ok: false, reason: "Only an administrator can give access on this Polaris" };
        if (input.toStranger && mode !== "invite") {
            return { ok: false, reason: "No account matches that. Ask an administrator to invite them." };
        }
        return { ok: true };
    }
}));
vi.mock("@/lib/apps/install-access", () => ({
    installRef: (id: string) => ({ kind: "install", id }),
    gamePermissionsFor: async () => held,
    sharingRightsFor: async () => ({ mayPassOn, until }),
    requireGameServer: async () => ({
        user: { id: BOB, isAdmin, viewingAs: undefined },
        access: { ownerId: ALICE, isOwner, install: { id: SERVER, name: "Survival" } }
    })
}));
vi.mock("@polaris/auth", () => ({
    grantsOnResource: async () => [],
    removeResourceGrant: async () => undefined,
    setResourceGrant: async (input: Record<string, unknown>) => {
        written = input;
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findFirst: async () => target,
            findUnique: async () => ({ name: "Alice", email: "alice@example.com" })
        },
        group: { findMany: async () => [] },
        role: { findMany: async () => [] }
    }
}));

const { shareInstall } = await import("../../src/lib/apps/install-sharing");

beforeEach(() => {
    held = ["games.read", "games.moderate"];
    mayPassOn = true;
    until = null;
    isOwner = true;
    isAdmin = false;
    mode = "existing";
    target = { id: BOB, name: "Bob" };
    written = null;
    invited = null;
});

describe("what a sharer may hand out", () => {
    it("never more than they hold on this server", async () => {
        // The dialog asked for manage; the sharer only moderates.
        const result = await shareInstall({
            installedAppId: SERVER,
            identifier: "bob@example.com",
            actions: ["games.read", "games.moderate", "games.manage"],
            canShare: false,
            expiresInDays: null
        });
        expect(result.granted).toBe(true);
        expect(written?.actions).toEqual(["games.read", "games.moderate"]);
    });

    it("refuses when nothing they asked for survives", async () => {
        held = ["games.read"];
        const result = await shareInstall({
            installedAppId: SERVER,
            identifier: "bob@example.com",
            actions: ["games.manage"],
            canShare: false,
            expiresInDays: null
        });
        expect(result.error).toBe("Choose at least one thing they may do");
        expect(written).toBeNull();
    });

    it("always writes an allow, never a deny", async () => {
        await shareInstall({
            installedAppId: SERVER,
            identifier: "bob@example.com",
            actions: ["games.moderate"],
            canShare: false,
            expiresInDays: null
        });
        expect(written?.effect).toBe("allow");
    });
});

describe("passing it on", () => {
    it("cannot be given by somebody who does not hold it", async () => {
        isOwner = false;
        mayPassOn = false;
        const result = await shareInstall({
            installedAppId: SERVER,
            identifier: "bob@example.com",
            actions: ["games.moderate"],
            canShare: true,
            expiresInDays: null
        });
        expect(result.error).toBe("You cannot give other people access to this");
        expect(written).toBeNull();
    });

    it("is given when the sharer owns the server", async () => {
        await shareInstall({
            installedAppId: SERVER,
            identifier: "bob@example.com",
            actions: ["games.moderate"],
            canShare: true,
            expiresInDays: null
        });
        expect(written?.canShare).toBe(true);
    });
});

describe("how long it lasts", () => {
    it("is clamped to the sharer's own end date", async () => {
        isOwner = false;
        // Their own access runs out in a day; they offered thirty.
        until = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await shareInstall({
            installedAppId: SERVER,
            identifier: "bob@example.com",
            actions: ["games.moderate"],
            canShare: false,
            expiresInDays: 30
        });
        expect((written?.expiresAt as Date).getTime()).toBe(until.getTime());
    });

    it("inherits an end date even when none was asked for", async () => {
        isOwner = false;
        until = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await shareInstall({
            installedAppId: SERVER,
            identifier: "bob@example.com",
            actions: ["games.moderate"],
            canShare: false,
            expiresInDays: null
        });
        expect((written?.expiresAt as Date).getTime()).toBe(until.getTime());
    });
});

describe("an address with no account", () => {
    it("is refused while the instance only allows sharing with existing accounts", async () => {
        target = null;
        const result = await shareInstall({
            installedAppId: SERVER,
            identifier: "stranger@example.com",
            actions: ["games.moderate"],
            canShare: false,
            expiresInDays: null
        });
        expect(result.error).toBe("No account matches that. Ask an administrator to invite them.");
        expect(invited).toBeNull();
    });

    it("becomes an invite carrying the grant once the operator allows it", async () => {
        target = null;
        mode = "invite";
        const result = await shareInstall({
            installedAppId: SERVER,
            identifier: "stranger@example.com",
            actions: ["games.moderate"],
            canShare: false,
            expiresInDays: null
        });
        expect(result.invite?.url).toContain("accept-invite");
        // The account it would create holds nothing on its own.
        expect(invited?.role).toBe("guest");
        expect(invited?.delegated).toBe(true);
        expect(invited?.pendingGrant).toMatchObject({
            resourceKind: "install",
            resourceId: SERVER,
            actions: ["games.read", "games.moderate"]
        });
    });

    it("is still refused a username that matches nobody", async () => {
        target = null;
        mode = "invite";
        const result = await shareInstall({
            installedAppId: SERVER,
            identifier: "stranger",
            actions: ["games.moderate"],
            canShare: false,
            expiresInDays: null
        });
        expect(result.error).toBe("No account matches that. Invite them by email address.");
    });
});

/**
 * The VPN in the app switcher: offered to an administrator, to somebody given
 * access, and to everybody only once access is opened to all - never to an
 * account merely for being signed in.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ access: null as object | null }));

vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session-guard", () => ({ guardSession: vi.fn() }));
vi.mock("@/lib/view-as-service", () => ({ resolveViewAs: vi.fn() }));
vi.mock("@polaris/auth", () => ({
    canAny: vi.fn(async () => true),
    userHasPermission: vi.fn(async () => true)
}));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: vi.fn(async () => true) }));
vi.mock("@/lib/polar/access", () => ({ polarAccessFor: vi.fn(async () => ({ use: true })) }));
vi.mock("@/lib/access/grants", () => ({ reachesAnySubject: vi.fn(async () => false) }));
vi.mock("@/lib/app-extensions/registry", () => ({ appReaches: vi.fn(async () => false) }));
vi.mock("@/lib/vpn/wireguard-service", () => ({ accessOf: vi.fn(async () => state.access) }));

const { accessFor } = await import("@/lib/session");
const { reachableApps } = await import("@/lib/app-access");

const member = { id: "u1", email: "ada@example.com", name: "Ada", isAdmin: false, sessionId: "s1" };

async function offered(user = member): Promise<string[]> {
    return (await reachableApps(accessFor(user))).map((app) => app.id);
}

beforeEach(() => {
    state.access = null;
});

describe("the VPN in the app switcher", () => {
    it("is not offered to an account the VPN was not given to", async () => {
        const ids = await offered();
        expect(ids).toContain("drive");
        expect(ids).not.toContain("vpn");
    });

    it("is offered once the account has access", async () => {
        state.access = { nodes: [], deviceLimit: 5, dataLimitGb: null, expiresAt: null };
        expect(await offered()).toContain("vpn");
    });

    it("leaves a role preview to the role's grants", async () => {
        const previewing = {
            ...member,
            viewingAs: { mode: "role", grants: ["drive.read"] }
        } as unknown as typeof member;
        expect(await offered(previewing)).toContain("vpn");
    });
});

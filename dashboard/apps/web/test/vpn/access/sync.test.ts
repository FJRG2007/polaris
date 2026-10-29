import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    app: null as { id: string; config: string | null } | null,
    engine: null as {
        id: string;
        ownerId: string;
        applicationId: string | null;
        status: string;
    } | null,
    accounts: [] as { id: string; bannedAt: Date | null; disabledAt: Date | null }[],
    admins: [] as { id: string; name: string; email: string }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async ({ where }: { where: { catalogId: string } }) =>
                where.catalogId === "vpn" ? db.app : db.engine
        },
        user: {
            findMany: async ({ where }: { where: { isAdmin?: boolean; id?: { in: string[] } } }) =>
                where.isAdmin
                    ? db.admins
                    : db.accounts.filter((account) => where.id?.in.includes(account.id))
        }
    }
}));
vi.mock("@/lib/tls/managed-certificates", () => ({
    openText: (sealed: string | null) => sealed,
    sealText: (plain: string) => plain
}));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => "10.0.0.2" }));
vi.mock("@/lib/deploy/host-port", () => ({ hostPortForApp: () => 41000 }));

import { refreshVpnAccess } from "@/lib/vpn/service";
import { headscaleUserName, accountIdOf } from "@/lib/vpn/settings";

const KEPT = "0190f1c2-0000-7000-8000-000000000001";
const GONE = "0190f1c2-0000-7000-8000-000000000002";
const BANNED = "0190f1c2-0000-7000-8000-000000000003";
const DISABLED = "0190f1c2-0000-7000-8000-000000000004";

function user(id: string, accountId: string) {
    return { id, name: headscaleUserName(accountId), displayName: "", email: "" };
}

/** A Headscale that answers what the sync asks, and records every call. */
function headscale() {
    const calls: string[] = [];
    const users = [
        user("1", KEPT),
        user("2", GONE),
        user("3", BANNED),
        { ...user("4", KEPT), name: "someone-else" },
        user("5", DISABLED)
    ];
    const nodes: Record<string, { id: string; name: string; expiry: string | null }[]> = {
        [headscaleUserName(GONE)]: [{ id: "20", name: "phone", expiry: null }],
        [headscaleUserName(BANNED)]: [
            { id: "30", name: "laptop", expiry: null },
            { id: "31", name: "old", expiry: "2020-01-01T00:00:00Z" },
            { id: "32", name: "tv", expiry: "0001-01-01T00:00:00Z" }
        ],
        [headscaleUserName(DISABLED)]: [{ id: "50", name: "tablet", expiry: null }]
    };
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.pathname}${url.search}`);
        if (url.pathname === "/api/v1/user" && method === "GET") return Response.json({ users });
        if (url.pathname === "/api/v1/node" && method === "GET")
            return Response.json({ nodes: nodes[url.searchParams.get("user") ?? ""] ?? [] });
        return Response.json({});
    });
    vi.stubGlobal("fetch", fetcher);
    return calls;
}

beforeEach(() => {
    vi.unstubAllGlobals();
    db.app = {
        id: "app",
        config: JSON.stringify({
            vpn: { enabled: true, apiKey: "key", hostname: "vpn.example.test" }
        })
    };
    db.engine = { id: "engine", ownerId: "owner", applicationId: "application", status: "running" };
    db.accounts = [
        { id: KEPT, bannedAt: null, disabledAt: null },
        { id: BANNED, bannedAt: new Date("2026-10-29T10:00:00Z"), disabledAt: null },
        { id: DISABLED, bannedAt: null, disabledAt: new Date("2026-10-29T10:00:00Z") }
    ];
    db.admins = [];
});

describe("bringing the VPN in line with the accounts", () => {
    it("reads an account back from the Headscale user Polaris made for it", () => {
        expect(accountIdOf(headscaleUserName(KEPT))).toBe(KEPT);
        expect(accountIdOf("someone-else")).toBeNull();
        expect(accountIdOf("polaris-not-a-uuid")).toBeNull();
    });

    it("deletes a deleted account's devices and user, signs a banned one's out, and leaves the rest", async () => {
        const calls = headscale();
        await refreshVpnAccess();
        expect(calls).toContain("PUT /api/v1/policy");
        expect(calls).toContain("DELETE /api/v1/node/20");
        expect(calls).toContain("DELETE /api/v1/user/2");
        expect(calls).toContain("POST /api/v1/node/30/expire");
        // Already expired: nothing to sign out.
        expect(calls).not.toContain("POST /api/v1/node/31/expire");
        // Headscale's zero time is "never expires", so it is signed out too.
        expect(calls).toContain("POST /api/v1/node/32/expire");
        // A switched-off account is signed out like a banned one, and kept.
        expect(calls).toContain("POST /api/v1/node/50/expire");
        expect(calls).not.toContain("DELETE /api/v1/user/5");
        expect(
            calls.filter((call) => call.includes("/user/1") || call.includes("/user/4"))
        ).toEqual([]);
        expect(calls).not.toContain(`GET /api/v1/node?user=${headscaleUserName(KEPT)}`);
        // A device is deleted before its user, which Headscale refuses otherwise.
        expect(calls.indexOf("DELETE /api/v1/node/20")).toBeLessThan(
            calls.indexOf("DELETE /api/v1/user/2")
        );
    });

    it("re-writes the policy for the administrators there are now", async () => {
        db.admins = [{ id: KEPT, name: "Ada", email: "ada@example.test" }];
        headscale();
        await refreshVpnAccess();
        const put = vi
            .mocked(fetch)
            .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
        const { policy } = JSON.parse(String((put?.[1] as RequestInit).body)) as { policy: string };
        expect(JSON.parse(policy).groups).toEqual({
            "group:admins": [`${headscaleUserName(KEPT)}@`]
        });
    });

    it("does nothing while the VPN is off", async () => {
        db.app = { id: "app", config: JSON.stringify({ vpn: { enabled: false, apiKey: "key" } }) };
        const calls = headscale();
        await refreshVpnAccess();
        expect(calls).toEqual([]);
    });

    it("does nothing when the VPN is not installed", async () => {
        db.app = null;
        const calls = headscale();
        await refreshVpnAccess();
        expect(calls).toEqual([]);
    });

    it("never throws when the server cannot be reached", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("down", { status: 502 }))
        );
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(refreshVpnAccess()).resolves.toBeUndefined();
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
});

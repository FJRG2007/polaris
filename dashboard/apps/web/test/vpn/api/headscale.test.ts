import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import * as rules from "@/lib/vpn/settings";
import { apiKeyIn, approvedRoutesFor, deviceOf } from "@/lib/vpn/service";
import { headscaleClient, headscaleNodeSchema, HeadscaleError } from "@/lib/vpn/headscale-client";

/** A node as grpc-gateway writes one: camelCase names, 64-bit ids as strings. */
const node = {
    id: "7",
    machineKey: "mkey:abc",
    name: "laptop",
    givenName: "laptop",
    user: { id: "3", name: "polaris-u1", displayName: "Ada", email: "ada@example.test" },
    ipAddresses: ["100.64.0.7", "fd7a:115c:a1e0::7"],
    lastSeen: "2026-10-29T10:00:00Z",
    online: true,
    approvedRoutes: [],
    availableRoutes: ["0.0.0.0/0", "::/0", "192.168.1.0/24"],
    subnetRoutes: [],
    tags: []
};

function fake(body: unknown, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function api(fetcher: ReturnType<typeof fake>) {
    return headscaleClient("http://h:1", "key", fetcher as unknown as typeof fetch);
}

function call(fetcher: ReturnType<typeof fake>): [string, RequestInit] {
    return fetcher.mock.calls[0] as unknown as [string, RequestInit];
}

describe("headscaleClient", () => {
    it("parses the camelCase node list and signs the call", async () => {
        const fetcher = fake({ nodes: [node] });
        const nodes = await api(fetcher).listNodes("polaris-u1");
        expect(nodes[0]).toMatchObject({ id: "7", givenName: "laptop", online: true });
        expect(nodes[0]?.ipAddresses).toEqual(["100.64.0.7", "fd7a:115c:a1e0::7"]);
        const [url, init] = call(fetcher);
        expect(url).toBe("http://h:1/api/v1/node?user=polaris-u1");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
    });

    it("accepts the snake_case spelling and numeric ids too", async () => {
        const fetcher = fake({
            nodes: [{ id: 9, name: "tv", given_name: "tv", ip_addresses: ["100.64.0.9"] }]
        });
        const [parsed] = await api(fetcher).listNodes();
        expect(parsed).toMatchObject({ id: "9", givenName: "tv", online: false });
        expect(parsed?.availableRoutes).toEqual([]);
    });

    it("sends the browser registration with the user name and auth id", async () => {
        const fetcher = fake({ node });
        await api(fetcher).registerNode("polaris-u1", "hskey-authreq-abcdefghijklmnopqrstuvwx");
        const [url, init] = call(fetcher);
        expect(url).toBe("http://h:1/api/v1/auth/register");
        expect(JSON.parse(String(init.body))).toEqual({
            user: "polaris-u1",
            auth_id: "hskey-authreq-abcdefghijklmnopqrstuvwx"
        });
    });

    it("parses a preauth key", async () => {
        const fetcher = fake({
            preAuthKey: { id: "1", key: "hskey-auth-xyz", expiration: "2026-10-29T11:00:00Z" }
        });
        const key = await api(fetcher).createPreAuthKey({
            userId: "3",
            reusable: false,
            ephemeral: false,
            expiration: new Date("2026-10-29T11:00:00Z")
        });
        expect(key.key).toBe("hskey-auth-xyz");
        expect(JSON.parse(String(call(fetcher)[1].body))).toMatchObject({ user: "3" });
    });

    it("refuses a response that is not the shape it reads", async () => {
        await expect(api(fake({ nodes: [{ id: "x" }] })).listNodes()).rejects.toThrow();
    });

    it("turns a failed status into a HeadscaleError", async () => {
        await expect(api(fake({ message: "no" }, 401)).health()).rejects.toBeInstanceOf(
            HeadscaleError
        );
    });
});

describe("registration ids", () => {
    it("accepts exactly the shape Headscale mints", () => {
        const ok = "hskey-authreq-abcdefghijklmnopqrstuv-_";
        expect(rules.authIdSchema.safeParse(ok).success).toBe(true);
        expect(rules.authIdSchema.safeParse("hskey-authreq-short").success).toBe(false);
        expect(rules.authIdSchema.safeParse(`${ok.slice(0, -1)}/`).success).toBe(false);
        expect(rules.authIdSchema.safeParse("../../api/v1/apikey").success).toBe(false);
    });
});

describe("who manages what", () => {
    const admin = { id: "a1", isAdmin: true };
    const member = { id: "U1", isAdmin: false };

    it("names the Headscale user after the account id", () => {
        expect(rules.headscaleUserName("U1")).toBe("polaris-u1");
    });

    it("lets a member manage only their own devices, an administrator every one", () => {
        expect(rules.mayManageDevice(member, "polaris-u1")).toBe(true);
        expect(rules.mayManageDevice(member, "polaris-u2")).toBe(false);
        expect(rules.mayManageDevice(admin, "polaris-u2")).toBe(true);
    });

    it("keeps turning on and route approval with administrators", () => {
        expect(rules.mayOperate(member)).toBe(false);
        expect(rules.mayApproveRoutes(member)).toBe(false);
        expect(rules.mayOperate(admin)).toBe(true);
        expect(rules.mayApproveRoutes(admin)).toBe(true);
    });
});

describe("routes", () => {
    const available = ["0.0.0.0/0", "::/0", "192.168.1.0/24"];

    it("approves only what the device advertises", () => {
        expect(approvedRoutesFor(available, { exitNode: true, routes: ["10.0.0.0/8"] })).toEqual([
            "0.0.0.0/0",
            "::/0"
        ]);
        expect(
            approvedRoutesFor(available, { exitNode: false, routes: ["192.168.1.0/24", "::/0"] })
        ).toEqual(["192.168.1.0/24"]);
    });

    it("splits the exit node from subnet routes for the screen", () => {
        const parsed = headscaleNodeSchema.parse({
            id: "1",
            name: "r",
            availableRoutes: available,
            approvedRoutes: ["192.168.1.0/24"]
        });
        const device = deviceOf(parsed);
        expect(device.exitNode).toEqual({ offered: true, approved: false });
        expect(device.routes).toEqual([{ route: "192.168.1.0/24", approved: true }]);
    });
});

describe("apiKeyIn", () => {
    it("reads the key off the CLI's last line", () => {
        expect(apiKeyIn("INF starting\nabcDEF123.ghiJKL456_xyz\n")).toBe("abcDEF123.ghiJKL456_xyz");
        expect(apiKeyIn("Error: could not connect")).toBeNull();
    });
});

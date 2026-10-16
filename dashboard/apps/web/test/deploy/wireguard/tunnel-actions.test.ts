/**
 * The Tunnels actions: who may call them, what they accept, and what reaches the
 * screen when something fails.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    allowed: true,
    created: [] as unknown[],
    failWith: null as unknown
}));

class Denied extends Error {}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/session", () => ({
    requirePermission: vi.fn(async (permission: string) => {
        if (!fake.allowed) throw new Denied(`denied ${permission}`);
        return { id: "0190a8c4-0000-7000-8000-00000000000a" };
    })
}));
vi.mock("@/lib/deploy/wireguard/tunnel-service", async () => {
    class TunnelRefusal extends Error {
        public constructor(public readonly code: string) {
            super(code);
        }
    }
    return {
        TunnelRefusal,
        createTunnel: vi.fn(async (_owner: string, input: unknown) => {
            if (fake.failWith) throw fake.failWith;
            fake.created.push(input);
            return { id: "0190a8c4-0000-7000-8000-0000000000ff" };
        }),
        setTunnelPaused: vi.fn(async () => undefined),
        removeTunnel: vi.fn(async () => undefined),
        readTunnelStatus: vi.fn(async () => ({ health: "up", lastHandshake: 1, rxBytes: 2, txBytes: 3 }))
    };
});

const actions = await import("../../../src/app/(app)/apps/tunnels/actions");
const service = await import("@/lib/deploy/wireguard/tunnel-service");
const session = await import("@/lib/session");

const SERVER = "0190a8c4-0000-7000-8000-0000000000aa";
const SERVICE = "0190a8c4-0000-7000-8000-0000000000bb";

beforeEach(() => {
    fake.allowed = true;
    fake.created = [];
    fake.failWith = null;
    vi.mocked(service.removeTunnel).mockClear();
    vi.mocked(service.createTunnel).mockClear();
});

describe("tunnel actions", () => {
    it("asks for the deploy management permission and does nothing without it", async () => {
        fake.allowed = false;
        await expect(
            actions.createTunnelAction({ publicServerId: SERVER, serviceId: SERVICE, hostname: "app.example.com" })
        ).rejects.toThrow("denied deploy.manage");
        await expect(actions.removeTunnelAction({ id: SERVER })).rejects.toThrow("denied deploy.manage");
        await expect(actions.setTunnelPausedAction({ id: SERVER, paused: true })).rejects.toThrow(
            "denied deploy.manage"
        );
        await expect(actions.tunnelStatusAction({ id: SERVER })).rejects.toThrow("denied deploy.manage");
        expect(service.createTunnel).not.toHaveBeenCalled();
        expect(service.removeTunnel).not.toHaveBeenCalled();
        expect(vi.mocked(session.requirePermission).mock.calls.every(([p]) => p === "deploy.manage")).toBe(true);
    });

    it("normalizes the hostname before handing it on", async () => {
        const reply = await actions.createTunnelAction({
            publicServerId: SERVER,
            serviceId: SERVICE,
            hostname: "  HTTPS://App.Example.com/ "
        });
        expect(reply.error).toBeUndefined();
        expect(fake.created).toEqual([{ publicServerId: SERVER, serviceId: SERVICE, hostname: "app.example.com" }]);
    });

    it("refuses a malformed body without calling the service", async () => {
        const reply = await actions.createTunnelAction({ publicServerId: "x", serviceId: SERVICE, hostname: "a.b" });
        expect(reply.error).toBeTruthy();
        expect(service.createTunnel).not.toHaveBeenCalled();
        expect((await actions.removeTunnelAction({ id: "../etc" })).error).toBeTruthy();
        expect(service.removeTunnel).not.toHaveBeenCalled();
    });

    it("shows a refusal in its own words and hides anything else", async () => {
        fake.failWith = new service.TunnelRefusal("sameServer");
        const refused = await actions.createTunnelAction({
            publicServerId: SERVER,
            serviceId: SERVICE,
            hostname: "app.example.com"
        });
        expect(refused.error).toBe("The service already runs on that server. Pick a service on another server.");

        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        fake.failWith = new Error("ssh: connect to host 10.0.0.4 port 22: /root/.ssh/id_ed25519");
        const failed = await actions.createTunnelAction({
            publicServerId: SERVER,
            serviceId: SERVICE,
            hostname: "app.example.com"
        });
        quiet.mockRestore();
        expect(failed.error).toBe("The tunnel could not be changed. Try again in a moment.");
        expect(failed.error).not.toContain("10.0.0.4");
    });
});

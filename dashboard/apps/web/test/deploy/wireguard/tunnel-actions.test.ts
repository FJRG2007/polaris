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
        public constructor(
            public readonly code: string,
            public readonly params: Record<string, string> = {}
        ) {
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
        removeTunnel: vi.fn(async () => {
            if (fake.failWith) throw fake.failWith;
        }),
        readTunnelStatuses: vi.fn(async (_owner: string, ids: string[]) =>
            Object.fromEntries(
                ids.map((id) => [id, { health: "up", lastHandshake: 1, rxBytes: 2, txBytes: 3 }])
            )
        )
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
            actions.createTunnelAction({
                publicServerId: SERVER,
                serviceId: SERVICE,
                hostname: "app.example.com"
            })
        ).rejects.toThrow("denied deploy.manage");
        await expect(actions.removeTunnelAction({ id: SERVER })).rejects.toThrow(
            "denied deploy.manage"
        );
        await expect(actions.setTunnelPausedAction({ id: SERVER, paused: true })).rejects.toThrow(
            "denied deploy.manage"
        );
        await expect(actions.tunnelStatusesAction({ ids: [SERVER] })).rejects.toThrow(
            "denied deploy.manage"
        );
        expect(service.createTunnel).not.toHaveBeenCalled();
        expect(service.removeTunnel).not.toHaveBeenCalled();
        expect(
            vi.mocked(session.requirePermission).mock.calls.every(([p]) => p === "deploy.manage")
        ).toBe(true);
    });

    it("normalizes the hostname before handing it on", async () => {
        const reply = await actions.createTunnelAction({
            publicServerId: SERVER,
            serviceId: SERVICE,
            hostname: "  HTTPS://App.Example.com/ "
        });
        expect(reply.error).toBeUndefined();
        expect(fake.created).toEqual([
            { publicServerId: SERVER, serviceId: SERVICE, hostname: "app.example.com" }
        ]);
    });

    it("refuses a malformed body without calling the service", async () => {
        const reply = await actions.createTunnelAction({
            publicServerId: "x",
            serviceId: SERVICE,
            hostname: "a.b"
        });
        expect(reply.error).toBeTruthy();
        expect(service.createTunnel).not.toHaveBeenCalled();
        expect((await actions.removeTunnelAction({ id: "../etc" })).error).toBeTruthy();
        expect(service.removeTunnel).not.toHaveBeenCalled();
    });

    it("reads every tunnel on screen in one call, and refuses a list it should not take", async () => {
        const reply = await actions.tunnelStatusesAction({ ids: [SERVER, SERVICE] });
        expect(Object.keys(reply.statuses ?? {})).toEqual([SERVER, SERVICE]);
        expect(service.readTunnelStatuses).toHaveBeenCalledWith(
            "0190a8c4-0000-7000-8000-00000000000a",
            [SERVER, SERVICE]
        );
        expect((await actions.tunnelStatusesAction({ ids: [] })).error).toBeTruthy();
        expect((await actions.tunnelStatusesAction({ ids: ["../etc"] })).error).toBeTruthy();
        expect(
            (await actions.tunnelStatusesAction({ ids: Array.from({ length: 201 }, () => SERVER) }))
                .error
        ).toBeTruthy();
        expect(service.readTunnelStatuses).toHaveBeenCalledTimes(1);
    });

    it("says a pause that left an end running should be paused again, not removed", async () => {
        vi.mocked(service.setTunnelPaused).mockRejectedValueOnce(
            new service.TunnelRefusal("leftoverPaused", { servers: "edge-1" })
        );
        const reply = await actions.setTunnelPausedAction({ id: SERVER, paused: true });
        expect(reply.error).toBe(
            "The tunnel is paused, but its end on edge-1 is still running. Pause it again once it is back."
        );
    });

    it("shows a refusal in its own words and hides anything else", async () => {
        fake.failWith = new service.TunnelRefusal("sameServer");
        const refused = await actions.createTunnelAction({
            publicServerId: SERVER,
            serviceId: SERVICE,
            hostname: "app.example.com"
        });
        expect(refused.error).toBe(
            "The service already runs on that server. Pick a service on another server."
        );

        fake.failWith = new service.TunnelRefusal("leftover", { servers: "home-box" });
        const left = await actions.removeTunnelAction({ id: SERVER });
        expect(left.error).toBe(
            "The tunnel is paused, but home-box could not be cleaned up. Remove it again once it is back."
        );

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

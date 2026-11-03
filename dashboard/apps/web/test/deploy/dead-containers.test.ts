/**
 * Which of Polaris's own sidecars a pass removes: a pure decision over what the
 * machine lists and what Polaris holds, so these cases are the whole of what the
 * reaper may take down. Nothing runs on a machine.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/hostd-client", () => ({ HostdClient: class {} }));
vi.mock("@/lib/deploy/service-networks", () => ({ wantedPrivateNetworks: async () => [] }));
vi.mock("@/lib/tunnel-service", () => ({ accountTunnelWanted: async () => false }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/notifications/operators", () => ({ notifyOperators: async () => undefined }));
vi.mock("@/lib/i18n/translate", () => ({ translatorFor: () => (key: string) => key }));

const { deadSidecars, DEAD_GRACE_MS } = await import("@/lib/deploy/dead-containers");
const { sidecarOf } = await import("@polaris/deploy");

const NOW = new Date("2026-11-03T12:00:00Z");
const OLD = new Date(NOW.getTime() - DEAD_GRACE_MS - 1).toISOString();
const NEW = new Date(NOW.getTime() - 60_000).toISOString();
const LIVE_APP = "polaris-0a1b2c3d";
const GONE_APP = "polaris-deadbeef";

function container(project: string | null, image = "cloudflare/cloudflared:latest", createdAt = OLD) {
    return {
        id: `id-${project}`,
        name: `name-${project}`,
        image,
        project,
        running: true,
        status: "Up 3 days",
        createdAt,
        networks: []
    };
}

const owners = { appProjects: new Set([LIVE_APP]), accountTunnel: true };

describe("sidecarOf", () => {
    it("tells the account tunnel's provider from its image", () => {
        expect(sidecarOf("polaris-tunnel", "ngrok/ngrok:latest")?.feature).toBe("tunnel-ngrok");
        expect(sidecarOf("polaris-tunnel", "cloudflare/cloudflared:latest")?.feature).toBe(
            "tunnel-cloudflare"
        );
    });

    it("names a service's tunnel and the service it belongs to", () => {
        expect(sidecarOf("polaris-ntunnel-0a1b2c3d", "x")).toEqual({
            feature: "app-tunnel-named",
            project: "polaris-ntunnel-0a1b2c3d",
            appProject: LIVE_APP
        });
        expect(sidecarOf("polaris-qtunnel-0a1b2c3d", "x")?.feature).toBe("app-tunnel-quick");
        expect(sidecarOf("polaris-ngrok-0a1b2c3d", "x")?.feature).toBe("app-tunnel-ngrok");
    });

    it("matches exact projects only", () => {
        expect(sidecarOf("polaris", "x")).toBeNull();
        expect(sidecarOf(LIVE_APP, "x")).toBeNull();
        expect(sidecarOf("polaris-tunnel-2", "x")).toBeNull();
        expect(sidecarOf("polaris-ntunnel-0A1B2C3D", "x")).toBeNull();
        expect(sidecarOf("polaris-ntunnel-0a1b2c3d-x", "x")).toBeNull();
        expect(sidecarOf("my-tunnel", "x")).toBeNull();
        expect(sidecarOf(null, "x")).toBeNull();
        expect(sidecarOf("polaris-ptunnel", "x")?.feature).toBe("share-tunnel");
        expect(sidecarOf("polaris-backup-tunnel", "x")?.feature).toBe("backup-tunnel");
    });
});

describe("deadSidecars", () => {
    it("removes a service's tunnel once the service is gone", () => {
        const dead = deadSidecars(
            [container("polaris-ntunnel-deadbeef"), container("polaris-ntunnel-0a1b2c3d")],
            owners,
            NOW
        );
        expect(dead).toEqual([
            {
                id: "id-polaris-ntunnel-deadbeef",
                name: "name-polaris-ntunnel-deadbeef",
                project: "polaris-ntunnel-deadbeef",
                feature: "app-tunnel-named",
                reason: "owner-gone"
            }
        ]);
    });

    it("removes the account tunnel only while no provider is on", () => {
        const tunnel = container("polaris-tunnel", "ngrok/ngrok:latest");
        expect(deadSidecars([tunnel], owners, NOW)).toEqual([]);
        expect(deadSidecars([tunnel], { ...owners, accountTunnel: false }, NOW)).toMatchObject([
            { feature: "tunnel-ngrok", reason: "feature-off" }
        ]);
    });

    it("keeps everything whose owner could not be read", () => {
        const listed = [container("polaris-tunnel"), container("polaris-qtunnel-deadbeef")];
        expect(deadSidecars(listed, { appProjects: null, accountTunnel: null }, NOW)).toEqual([]);
    });

    it("keeps a container inside the grace, or with no creation time", () => {
        const off = { ...owners, accountTunnel: false };
        expect(deadSidecars([container("polaris-tunnel", "x", NEW)], off, NOW)).toEqual([]);
        const unknown = { ...container("polaris-tunnel"), createdAt: null };
        expect(deadSidecars([unknown], off, NOW)).toEqual([]);
    });

    it("never touches the share or backup tunnel, Polaris itself, apps or others", () => {
        const listed = [
            container("polaris-ptunnel"),
            container("polaris-backup-tunnel"),
            container("polaris"),
            container(GONE_APP),
            container(null),
            container("somebody-else")
        ];
        expect(deadSidecars(listed, { appProjects: new Set(), accountTunnel: false }, NOW)).toEqual(
            []
        );
    });
});

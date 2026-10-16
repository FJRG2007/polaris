/**
 * The two server-side halves the renderers do not cover: a tunnel's private keys
 * are stored sealed and come back intact, and the route file reaches a remote
 * edge the same atomic way the app routes do - and under no other name.
 */

import { describe, expect, it, vi } from "vitest";

const MASTER = Buffer.alloc(32, 7).toString("base64");
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: MASTER }) }));

const { openKey, sealKey } = await import("@/lib/deploy/wireguard/tunnel-service");
const { RemoteRouter, remoteWriteScript } = await import("@/lib/deploy/router-remote");
const wg = await import("@/lib/deploy/wireguard/tunnel-config");

describe("sealed private keys", () => {
    it("round-trips a key and never stores it in the clear", () => {
        const { privateKey } = wg.generateKeyPair();
        const sealed = sealKey(privateKey);
        expect(sealed).not.toContain(privateKey);
        expect(openKey(sealed)).toBe(privateKey);
    });

    it("seals the same key differently each time", () => {
        const { privateKey } = wg.generateKeyPair();
        expect(sealKey(privateKey)).not.toBe(sealKey(privateKey));
    });

    it("refuses to open under another master key", () => {
        const sealed = sealKey(wg.generateKeyPair().privateKey);
        expect(() => openKey(sealed, Buffer.alloc(32, 9).toString("base64"))).toThrow();
    });
});

describe("the tunnel route file on a remote edge", () => {
    it("is written beside its target and renamed over it", () => {
        const script = remoteWriteScript(wg.renderTunnelRoutes([]), "n1", wg.TUNNEL_ROUTE_FILE);
        expect(script).toContain(`/.${wg.TUNNEL_ROUTE_FILE}.n1`);
        const temporary = `${wg.TUNNEL_ROUTE_FILE}\\.n1`;
        expect(script).toMatch(
            new RegExp(`^mv -f '?\\S*/\\.${temporary}'? '?\\S*/${wg.TUNNEL_ROUTE_FILE}'?$`, "m")
        );
        expect(script).not.toContain("polaris-apps.yml");
    });

    it("refuses any file but one of Polaris's own, and never the app routes", async () => {
        const router = new RemoteRouter({
            address: "192.0.2.1",
            port: 22,
            username: "x",
            auth: { kind: "password", password: "x" } as never
        });
        await expect(router.pushFile("../etc/passwd", "a")).rejects.toThrow(/Not a file/);
        await expect(router.pushFile("polaris-apps.yml", "a")).rejects.toThrow(/Not a file/);
        await expect(router.pushFile("other.yml", "a")).rejects.toThrow(/Not a file/);
    });
});

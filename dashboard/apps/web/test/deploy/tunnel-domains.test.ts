/**
 * Tunnel hostnames surfaced to the UI. The quick-tunnel Setting holds JSON
 * (`{url, startedAt}`), so reading it as a bare URL leaked the raw record into the
 * app header as a domain; the other tunnel kinds store a plain hostname.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: { setting: { findMany } } }));

const { listActiveTunnelDomains } = await import("../../src/lib/deploy/tunnel-domains");

const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";

function settings(rows: Record<string, string>): void {
    findMany.mockResolvedValue(Object.entries(rows).map(([key, value]) => ({ key, value })));
}

describe("listActiveTunnelDomains", () => {
    beforeEach(() => { findMany.mockReset(); });

    it("reads the hostname out of a quick tunnel's JSON record", async () => {
        settings({
            [`deploy.qtunnel.${APP}`]: JSON.stringify({
                url: "https://ronald-kent-leg-plate.trycloudflare.com",
                startedAt: "2026-07-23T00:26:08.391Z"
            })
        });
        const domains = await listActiveTunnelDomains([APP]);
        expect(domains.get(APP)).toEqual([
            { id: `qtunnel:${APP}`, hostname: "ronald-kent-leg-plate.trycloudflare.com", kind: "tunnel", enabled: true }
        ]);
    });

    it("still reads an older plain-URL quick tunnel record", async () => {
        settings({ [`deploy.qtunnel.${APP}`]: "https://ronald-kent-leg-plate.trycloudflare.com" });
        const domains = await listActiveTunnelDomains([APP]);
        expect(domains.get(APP)?.[0]?.hostname).toBe("ronald-kent-leg-plate.trycloudflare.com");
    });

    it("shows no hostname while a live tunnel has not printed its URL yet", async () => {
        settings({ [`deploy.qtunnel.${APP}`]: JSON.stringify({ url: null, startedAt: null }) });
        const domains = await listActiveTunnelDomains([APP]);
        expect(domains.has(APP)).toBe(false);
    });

    it("keeps ngrok and named-tunnel hostnames, skipping a disabled named tunnel", async () => {
        settings({
            [`deploy.ngrok.${APP}`]: "https://abc123.ngrok-free.app",
            [`deploy.ntunnel.${APP}.hostname`]: "app.example.com",
            [`deploy.ntunnel.${APP}.disabled`]: "1"
        });
        const domains = await listActiveTunnelDomains([APP]);
        expect(domains.get(APP)?.map((domain) => domain.hostname)).toEqual(["abc123.ngrok-free.app"]);
    });
});

/**
 * Reading a tunnel's public URL back from its sidecar logs. cloudflared mints a new
 * hostname every time it starts and the container keeps the whole log across those
 * restarts, so a window can hold several URLs of which only the last is alive -
 * taking the first one is what pinned the UI to a dead link for days.
 */

import { describe, expect, it, vi } from "vitest";

const { newestUrl, tunnelReachable } = await import("../../src/lib/deploy/tunnel-url");

const CLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const NGROK = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/i;

/** A log window spanning two cloudflared runs inside one container. */
const RESTARTED = [
    "2026-07-23T00:26:08Z INF +--------------------------------------+",
    "2026-07-23T00:26:08Z INF |  https://ronald-kent-leg-plate.trycloudflare.com  |",
    "2026-07-23T00:26:08Z INF +--------------------------------------+",
    "2026-07-28T15:34:14Z INF Registered tunnel connection connIndex=0",
    "2026-07-28T15:34:14Z INF |  https://karl-statutes-heights-linda.trycloudflare.com  |"
].join("\n");

describe("newestUrl", () => {
    it("returns the most recent URL when a restart left an older one in the window", () => {
        expect(newestUrl(RESTARTED, CLOUDFLARE)).toBe("https://karl-statutes-heights-linda.trycloudflare.com");
    });

    it("returns the only URL when the sidecar has started once", () => {
        const log = "INF |  https://karl-statutes-heights-linda.trycloudflare.com  |";
        expect(newestUrl(log, CLOUDFLARE)).toBe("https://karl-statutes-heights-linda.trycloudflare.com");
    });

    it("returns null when the URL has not been printed yet", () => {
        expect(newestUrl("INF Starting tunnel", CLOUDFLARE)).toBeNull();
    });

    it("leaves a caller's already-global pattern alone", () => {
        const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
        expect(newestUrl(RESTARTED, pattern)).toBe("https://karl-statutes-heights-linda.trycloudflare.com");
    });

    it("reads the ngrok agent's format too", () => {
        const log = 'url=https://old-one.ngrok-free.app\nurl=https://new-one.ngrok-free.app';
        expect(newestUrl(log, NGROK)).toBe("https://new-one.ngrok-free.app");
    });
});

describe("tunnelReachable", () => {
    it("counts any origin response as reachable, including a rejection", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));
        await expect(tunnelReachable("https://x.trycloudflare.com")).resolves.toBe(true);
        vi.unstubAllGlobals();
    });

    it("treats an edge with nothing behind it as unreachable", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 530 }));
        await expect(tunnelReachable("https://x.trycloudflare.com")).resolves.toBe(false);
        vi.unstubAllGlobals();
    });

    it("treats a hostname that no longer resolves as unreachable", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));
        await expect(tunnelReachable("https://x.trycloudflare.com")).resolves.toBe(false);
        vi.unstubAllGlobals();
    });
});

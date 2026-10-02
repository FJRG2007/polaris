/**
 * Polaris's own answer to clickjacking: every page refuses to be framed by another
 * site, except a published calendar's embed, which exists to be framed. Matched with
 * the same path matcher Next uses for `headers()`, so a pattern that silently stopped
 * matching (or started matching the embed) fails here rather than in a browser.
 */

import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";
import { EMBED_FRAME_ORIGINS, embedFor } from "../../src/lib/chat/embeds";

async function headersFor(path: string): Promise<Record<string, string>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    const out: Record<string, string> = {};
    for (const rule of rules) {
        if (
            !pathToRegexp(rule.source, [], { strict: true, sensitive: false, delimiter: "/" }).test(
                path
            )
        )
            continue;
        for (const header of rule.headers) out[header.key] = header.value;
    }
    return out;
}

describe("Polaris's framing headers", () => {
    it("refuse other sites on every ordinary page", async () => {
        for (const path of ["/", "/home", "/mail", "/cal/book/abc", "/api/health", "/s/token"]) {
            expect(await headersFor(path), path).toEqual({
                "Content-Security-Policy": `frame-ancestors 'self'; frame-src 'self' ${EMBED_FRAME_ORIGINS.join(" ")}`,
                "X-Frame-Options": "SAMEORIGIN"
            });
        }
    });

    it("leave a published calendar's embed frameable by any site", async () => {
        expect(await headersFor("/cal/embed/abc123")).toEqual({});
    });

    it("let a page frame itself and the chat's players, and nothing broader", async () => {
        const policy = (await headersFor("/chat"))["Content-Security-Policy"] ?? "";
        const frameSrc = policy
            .split(";")
            .map((directive) => directive.trim())
            .find((directive) => directive.startsWith("frame-src"));
        const sources = (frameSrc ?? "").split(/\s+/).slice(1);

        expect(sources).toEqual(["'self'", ...EMBED_FRAME_ORIGINS]);
        for (const source of sources.slice(1)) {
            // An exact https origin each: no scheme-only source, no wildcard, no path.
            expect(source, source).toMatch(/^https:\/\/[a-z0-9.-]+$/);
        }
    });

    it("cover every player the chat builds", () => {
        // One address per provider and shape; a player whose origin is missing
        // from the policy is a play button that opens onto a blocked frame.
        const posted = [
            "https://youtu.be/dQw4w9WgXcQ",
            "https://vimeo.com/76979871",
            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
            "https://www.tiktok.com/@someone/video/7232918429372394779",
            "https://www.instagram.com/reel/CxYz123AbC_/",
            "https://x.com/someone/status/1700000000000000000",
            "https://www.twitch.tv/somestreamer",
            "https://www.twitch.tv/videos/1234567890",
            "https://clips.twitch.tv/SomeClipSlug-abc",
            "https://soundcloud.com/some-artist/a-track",
            "https://www.reddit.com/r/videos/comments/1abc2de/a_title/",
            "https://streamable.com/abc12x",
            "https://www.dailymotion.com/video/x8abc12",
            "https://kick.com/somestreamer"
        ];
        const used = new Set<string>();
        for (const address of posted) {
            const embed = embedFor(address);
            expect(embed, address).not.toBeNull();
            const origin = new URL(embed!.url).origin;
            expect(EMBED_FRAME_ORIGINS, address).toContain(origin);
            used.add(origin);
        }
        // And nothing in the list that no player uses, bar the one origin a
        // player redirects to on its own.
        const unused = EMBED_FRAME_ORIGINS.filter((origin) => !used.has(origin));
        expect(unused).toEqual(["https://geo.dailymotion.com"]);
    });
});

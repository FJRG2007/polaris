// @vitest-environment jsdom

/**
 * The "Polaris for phones" card on Downloads drew its skeleton for seconds:
 * its files waited on GitHub's release list (up to three pages, six seconds)
 * and on Google Play and F-Droid (five seconds) every time a cache's lifetime
 * ran out, because the cache blocked on expiry. A list already held is now what
 * the card draws, at once, and the lookups happen behind it - one per upstream
 * however many people open the page.
 */

import { AndroidFiles } from "@/components/app-download";
import { afterEach, describe, expect, it, vi } from "vitest";

const REPO = "example/phones";

const releases = [
    {
        tag_name: "android-v0.1.17",
        html_url: `https://github.com/${REPO}/releases/tag/android-v0.1.17`,
        published_at: "2026-11-20T10:00:00Z",
        assets: [
            {
                name: "polaris-android.apk",
                browser_download_url: `https://github.com/${REPO}/releases/download/android-v0.1.17/polaris-android.apk`
            }
        ]
    }
];

/** An upstream that never answers: anything that waits on it never resolves. */
const hanging = () => new Promise<never>(() => undefined);

/** Resolves "waited" after enough microtask turns for a cached answer to land,
 *  but long before any network could. */
async function waited(): Promise<"waited"> {
    for (let turn = 0; turn < 200; turn++) await Promise.resolve();
    return "waited";
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("the phones card on Downloads", () => {
    it("draws the release it last saw at once, while GitHub and the stores are asked again behind it", async () => {
        vi.useFakeTimers({ now: new Date("2026-11-28T09:00:00Z") });
        let up = true;
        const fetching = vi.fn(async (url: string) => {
            if (!up) return hanging();
            if (url.startsWith("https://api.github.com/")) {
                return { ok: true, status: 200, headers: new Headers({ etag: '"r1"' }), json: async () => releases };
            }
            return { ok: false, status: 404, headers: new Headers(), body: null };
        });
        vi.stubGlobal("fetch", fetching);

        // A first viewer, with nothing held yet.
        const first = await AndroidFiles({ repo: REPO });
        expect(first.props.download?.version).toBe("0.1.17");
        const asked = fetching.mock.calls.length;

        // Past every lifetime - two minutes for releases, six hours for stores -
        // and with every upstream hanging.
        vi.advanceTimersByTime(7 * 60 * 60 * 1000);
        up = false;

        const viewers = Array.from({ length: 100 }, () => AndroidFiles({ repo: REPO }));
        const outcome = await Promise.race([Promise.all(viewers), waited()]);

        expect(outcome).not.toBe("waited");
        const cards = outcome as Awaited<ReturnType<typeof AndroidFiles>>[];
        expect(cards.every((card) => card.props.download?.version === "0.1.17")).toBe(true);
        expect(cards.every((card) => card.props.unreachable === undefined)).toBe(true);

        // One refresh per upstream for the hundred: GitHub, Play, F-Droid.
        const again = fetching.mock.calls.slice(asked).map(([url]) => new URL(url).host);
        expect(again.sort()).toEqual(["api.github.com", "f-droid.org", "play.google.com"]);
    });
});

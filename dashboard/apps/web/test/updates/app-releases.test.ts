import { describe, expect, it } from "vitest";
import {
    DESKTOP_TAG_PREFIX,
    EXTENSION_TAG_PREFIX,
    pickRelease,
    type ReleaseListing
} from "../../src/lib/app-releases";

/**
 * Choosing which release is the app being asked for.
 *
 * The desktop card used to link to the releases page filtered by `desktop-v`,
 * whatever was there, and what was there was nothing - so the only button on it led
 * to "No releases found". Now a link is only drawn for a release that exists, and
 * these are the ways that choice can go wrong while still looking like it worked:
 * this repository releases three different things, a draft is invisible to everybody
 * who cannot edit the repository, and the order the API answers in is not a promise.
 */

const release = (over: Partial<ReleaseListing> = {}): ReleaseListing => ({
    tag_name: "desktop-v0.2.0",
    html_url: "https://github.com/example/polaris/releases/tag/desktop-v0.2.0",
    draft: false,
    published_at: "2026-07-20T10:00:00Z",
    ...over
});

describe("pickRelease", () => {
    it("offers nothing when there are no releases at all", () => {
        expect(pickRelease([], DESKTOP_TAG_PREFIX)).toBeNull();
    });

    it("offers nothing when only the dashboard has been released", () => {
        // The state this repository is actually in: dashboard-v tags and no others.
        const releases = [
            release({ tag_name: "dashboard-v0.4.6" }),
            release({ tag_name: "dashboard-v0.4.5" })
        ];
        expect(pickRelease(releases, DESKTOP_TAG_PREFIX)).toBeNull();
        expect(pickRelease(releases, EXTENSION_TAG_PREFIX)).toBeNull();
    });

    it("keeps the three kinds of release apart", () => {
        // The reason a prefix is passed in rather than assumed: one list holds all
        // of them, and asking for one must never answer with another.
        const releases = [
            release({ tag_name: "dashboard-v0.4.6", published_at: "2026-07-21T13:37:35Z" }),
            release({ tag_name: "desktop-v0.2.0", published_at: "2026-07-20T10:00:00Z" }),
            release({ tag_name: "extension-v0.1.0", published_at: "2026-07-19T10:00:00Z" })
        ];
        expect(pickRelease(releases, DESKTOP_TAG_PREFIX)?.version).toBe("0.2.0");
        expect(pickRelease(releases, EXTENSION_TAG_PREFIX)?.version).toBe("0.1.0");
    });

    it("never offers a draft, which only the repository's editors can open", () => {
        const found = pickRelease(
            [
                release({
                    tag_name: "desktop-v0.3.0",
                    draft: true,
                    published_at: "2026-08-01T00:00:00Z"
                }),
                release({ tag_name: "desktop-v0.2.0", published_at: "2026-07-20T10:00:00Z" })
            ],
            DESKTOP_TAG_PREFIX
        );
        expect(found?.version).toBe("0.2.0");
    });

    it("offers nothing when every matching release is a draft", () => {
        expect(pickRelease([release({ draft: true })], DESKTOP_TAG_PREFIX)).toBeNull();
    });

    it("takes the newest by publication date, not by position in the answer", () => {
        const found = pickRelease(
            [
                release({ tag_name: "desktop-v0.1.0", published_at: "2026-01-01T00:00:00Z" }),
                release({ tag_name: "desktop-v0.4.0", published_at: "2026-09-01T00:00:00Z" }),
                release({ tag_name: "desktop-v0.2.0", published_at: "2026-05-01T00:00:00Z" })
            ],
            DESKTOP_TAG_PREFIX
        );
        expect(found?.version).toBe("0.4.0");
    });

    it("reports the url of the release it chose", () => {
        const found = pickRelease(
            [
                release({
                    tag_name: "extension-v1.0.0",
                    html_url: "https://github.com/example/polaris/releases/tag/extension-v1.0.0",
                    published_at: "2026-09-02T00:00:00Z"
                })
            ],
            EXTENSION_TAG_PREFIX
        );
        expect(found?.url).toBe("https://github.com/example/polaris/releases/tag/extension-v1.0.0");
    });

    it("ignores entries whose fields are not what the API documents", () => {
        // Arrives from the network, so it is checked rather than trusted.
        const releases = [
            release({ tag_name: 42 }),
            release({ tag_name: undefined }),
            release({ html_url: undefined }),
            release({ html_url: "" })
        ];
        expect(pickRelease(releases, DESKTOP_TAG_PREFIX)).toBeNull();
    });

    it("still offers a release that carries no publication date", () => {
        const found = pickRelease([release({ published_at: undefined })], DESKTOP_TAG_PREFIX);
        expect(found?.version).toBe("0.2.0");
    });

    it("prefers a dated release over an undated one", () => {
        const found = pickRelease(
            [
                release({ tag_name: "desktop-v9.9.9", published_at: undefined }),
                release({ tag_name: "desktop-v0.2.0", published_at: "2026-07-20T10:00:00Z" })
            ],
            DESKTOP_TAG_PREFIX
        );
        expect(found?.version).toBe("0.2.0");
    });
});

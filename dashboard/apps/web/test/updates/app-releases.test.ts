import { describe, expect, it, vi } from "vitest";
import {
    DESKTOP_TAG_PREFIX,
    EXTENSION_TAG_PREFIX,
    desktopDownload,
    extensionDownload,
    pickFile,
    pickRelease,
    type AppFile,
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
 * who cannot edit the repository, a prerelease is a build nobody said was ready, and
 * the order the API answers in is not a promise.
 *
 * The lookup around it is covered too, because the same button goes quiet when the
 * release is real and simply further down the list than one page reaches.
 */

const release = (over: Partial<ReleaseListing> = {}): ReleaseListing => ({
    tag_name: "desktop-v0.2.0",
    html_url: "https://github.com/example/polaris/releases/tag/desktop-v0.2.0",
    draft: false,
    prerelease: false,
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

    it("never offers a prerelease, which is a build nobody said was ready", () => {
        // This is the only download a deployment draws, so an rc would not sit
        // beside the release as an option - it would be the release, for everybody.
        const found = pickRelease(
            [
                release({
                    tag_name: "desktop-v0.3.0-rc.1",
                    prerelease: true,
                    published_at: "2026-08-01T00:00:00Z"
                }),
                release({ tag_name: "desktop-v0.2.0", published_at: "2026-07-20T10:00:00Z" })
            ],
            DESKTOP_TAG_PREFIX
        );
        expect(found?.version).toBe("0.2.0");
    });

    it("offers nothing when every matching release is a prerelease", () => {
        expect(pickRelease([release({ prerelease: true })], DESKTOP_TAG_PREFIX)).toBeNull();
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

describe("the files on the release it chose", () => {
    it("carries the ones that can actually be fetched", () => {
        const found = pickRelease(
            [
                release({
                    assets: [
                        {
                            name: "Polaris-Setup.exe",
                            browser_download_url: "https://example.test/Polaris-Setup.exe"
                        },
                        {
                            name: "Polaris-0.2.0-arm64.dmg",
                            browser_download_url: "https://example.test/arm64.dmg"
                        }
                    ]
                })
            ],
            DESKTOP_TAG_PREFIX
        );
        expect(found?.files).toEqual([
            { name: "Polaris-Setup.exe", url: "https://example.test/Polaris-Setup.exe" },
            { name: "Polaris-0.2.0-arm64.dmg", url: "https://example.test/arm64.dmg" }
        ]);
    });

    it("is empty for a release that attached nothing", () => {
        expect(pickRelease([release()], DESKTOP_TAG_PREFIX)?.files).toEqual([]);
    });

    it("drops an entry missing a name or somewhere to fetch it from", () => {
        // Checked rather than trusted, the same as every other field here: a file
        // with no url is a button that goes nowhere.
        const found = pickRelease(
            [
                release({
                    assets: [
                        { name: "Polaris-Setup.exe" },
                        { browser_download_url: "https://example.test/nameless" },
                        { name: "", browser_download_url: "https://example.test/empty" },
                        { name: 42, browser_download_url: "https://example.test/number" },
                        {
                            name: "polaris-0.2.0.AppImage",
                            browser_download_url: "https://example.test/app.AppImage"
                        }
                    ]
                })
            ],
            DESKTOP_TAG_PREFIX
        );
        expect(found?.files).toEqual([
            { name: "polaris-0.2.0.AppImage", url: "https://example.test/app.AppImage" }
        ]);
    });

    it("takes no files from a shape that is not a list", () => {
        expect(pickRelease([release({ assets: "nope" })], DESKTOP_TAG_PREFIX)?.files).toEqual([]);
    });
});

/**
 * Picking one file out of a release.
 *
 * The names belong to the packagers, not to Polaris - electron-forge names the
 * per-architecture images, WXT names the browser packages - so a screen asks for
 * what it means and this answers with whatever matches. The case that matters is
 * Firefox: its package and the sources archive WXT writes beside it are both zips
 * with "firefox" nowhere near as distinguishing as it looks, and offering the
 * sources archive as the add-on is a download that installs nothing.
 */
describe("pickFile", () => {
    const files: readonly AppFile[] = [
        { name: "polaris-0.1.0-chrome.zip", url: "https://example.test/chrome.zip" },
        { name: "polaris-0.1.0-firefox.zip", url: "https://example.test/firefox.zip" },
        { name: "polaris-0.1.0-sources.zip", url: "https://example.test/sources.zip" },
        { name: "Polaris-0.2.0-arm64.dmg", url: "https://example.test/arm64.dmg" },
        { name: "Polaris-0.2.0-x64.dmg", url: "https://example.test/x64.dmg" }
    ];

    it("matches on every term, so an architecture picks its own image", () => {
        expect(pickFile(files, [".dmg", "arm64"])?.url).toBe("https://example.test/arm64.dmg");
        expect(pickFile(files, [".dmg", "x64"])?.url).toBe("https://example.test/x64.dmg");
    });

    it("avoids the terms it was told to avoid", () => {
        // Without this, "the zip for firefox" is satisfied by the sources archive
        // on any release that lists it first.
        expect(pickFile(files, [".zip", "firefox"], ["sources"])?.url).toBe(
            "https://example.test/firefox.zip"
        );
    });

    it("ignores case, because the names are not ours to spell", () => {
        expect(pickFile(files, [".DMG", "ARM64"])?.url).toBe("https://example.test/arm64.dmg");
    });

    it("answers nothing when this release has no such file", () => {
        expect(pickFile(files, [".deb"])).toBeNull();
        expect(pickFile([], [".exe"])).toBeNull();
    });
});

describe("appDownload", () => {
    const answering = (pages: Record<string, readonly ReleaseListing[]>) =>
        vi.fn(async (url: string) => ({
            ok: true,
            json: async () => pages[new URL(url).searchParams.get("page") ?? "1"] ?? []
        }));

    it("walks past a full page of other releases to reach the app's own", async () => {
        // One page used to be thirty releases of anything. A desktop release with
        // thirty dashboard releases published after it was then a button reading
        // "not released yet" for a release sitting right there, with nothing said
        // anywhere to tell that apart from never having cut one.
        const others = Array.from({ length: 100 }, (_, index) =>
            release({ tag_name: `dashboard-v0.${index}.0`, published_at: "2026-09-01T00:00:00Z" })
        );
        const fetching = answering({ "1": others, "2": [release({ tag_name: "desktop-v0.2.0" })] });
        vi.stubGlobal("fetch", fetching);
        try {
            expect((await desktopDownload("example/walks"))?.version).toBe("0.2.0");
            expect(fetching).toHaveBeenCalledTimes(2);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("stops at a page the API did not fill", async () => {
        const fetching = answering({ "1": [release({ tag_name: "dashboard-v0.4.6" })] });
        vi.stubGlobal("fetch", fetching);
        try {
            expect(await desktopDownload("example/stops")).toBeNull();
            expect(fetching).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    describe("once its answer is two minutes old", () => {
        // A release published a minute ago was shown as the one before it for ten
        // minutes, on a screen with no refresh of its own.
        const listed = (tags: readonly string[], etag: string) => ({
            ok: true,
            status: 200,
            headers: new Headers({ etag }),
            json: async () => tags.map((tag_name) => release({ tag_name }))
        });

        it("keeps the answer inside the two minutes without asking again", async () => {
            vi.useFakeTimers({ now: new Date("2026-09-30T18:00:00Z") });
            const fetching = vi.fn(async () => listed(["extension-v0.1.10"], '"a"'));
            vi.stubGlobal("fetch", fetching);
            try {
                expect((await extensionDownload("example/within"))?.version).toBe("0.1.10");
                vi.advanceTimersByTime(119_000);
                expect((await extensionDownload("example/within"))?.version).toBe("0.1.10");
                expect(fetching).toHaveBeenCalledTimes(1);
            } finally {
                vi.unstubAllGlobals();
                vi.useRealTimers();
            }
        });

        it("asks with the etag it had, and keeps its answer on a 304", async () => {
            vi.useFakeTimers({ now: new Date("2026-09-30T18:00:00Z") });
            const fetching = vi
                .fn()
                .mockResolvedValueOnce(listed(["extension-v0.1.10"], '"a"'))
                .mockResolvedValueOnce({ ok: false, status: 304, headers: new Headers(), json: async () => [] });
            vi.stubGlobal("fetch", fetching);
            try {
                await extensionDownload("example/unchanged");
                vi.advanceTimersByTime(121_000);
                expect((await extensionDownload("example/unchanged"))?.version).toBe("0.1.10");
                expect(fetching).toHaveBeenCalledTimes(2);
                const [, init] = fetching.mock.calls[1] as [string, RequestInit];
                expect((init.headers as Record<string, string>)["if-none-match"]).toBe('"a"');
            } finally {
                vi.unstubAllGlobals();
                vi.useRealTimers();
            }
        });

        it("does not hold on to an answer cut short by a later page failing", async () => {
            vi.useFakeTimers({ now: new Date("2026-09-30T18:00:00Z") });
            const full = Array.from({ length: 100 }, (_, index) => `dashboard-v0.${index}.0`);
            const fetching = vi
                .fn()
                .mockResolvedValueOnce(listed(full, '"a"'))
                .mockResolvedValueOnce({ ok: false, status: 403, headers: new Headers(), json: async () => [] })
                .mockResolvedValueOnce(listed(full, '"a"'))
                .mockResolvedValueOnce(listed(["extension-v0.1.10"], '"a2"'));
            vi.stubGlobal("fetch", fetching);
            try {
                expect(await extensionDownload("example/cut-short")).toBeNull();
                vi.advanceTimersByTime(121_000);
                expect((await extensionDownload("example/cut-short"))?.version).toBe("0.1.10");
                const [, init] = fetching.mock.calls[2] as [string, RequestInit];
                expect((init.headers as Record<string, string>)["if-none-match"]).toBeUndefined();
            } finally {
                vi.unstubAllGlobals();
                vi.useRealTimers();
            }
        });

        it("offers a release published since", async () => {
            vi.useFakeTimers({ now: new Date("2026-09-30T18:00:00Z") });
            const fetching = vi
                .fn()
                .mockResolvedValueOnce(listed(["extension-v0.1.10"], '"a"'))
                .mockResolvedValueOnce(listed(["extension-v0.1.12"], '"b"'));
            vi.stubGlobal("fetch", fetching);
            try {
                await extensionDownload("example/published");
                vi.advanceTimersByTime(121_000);
                expect((await extensionDownload("example/published"))?.version).toBe("0.1.12");
            } finally {
                vi.unstubAllGlobals();
                vi.useRealTimers();
            }
        });
    });
});

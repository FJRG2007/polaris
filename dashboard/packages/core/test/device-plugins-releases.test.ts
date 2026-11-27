/**
 * What's new on a plugin's page, one entry per version: the catalog's
 * structured `releases` when it has them, else the old one-string changelog
 * split on its version markers ("0.1.18: ... 0.1.17: ..."), newest first.
 */

import { describe, expect, it } from "vitest";
import { pluginEntrySchema, pluginReleases, splitPluginChangelog } from "../src/device-plugins.js";

describe("splitPluginChangelog", () => {
    it("splits the old string on each version, newest first", () => {
        const text = "0.1.18: on Windows, the driver sets itself up. 0.1.17: the screen speaks Spanish. 0.1.9: knobs turn faster.";
        expect(splitPluginChangelog(text)).toEqual([
            { version: "0.1.18", notes: "on Windows, the driver sets itself up." },
            { version: "0.1.17", notes: "the screen speaks Spanish." },
            { version: "0.1.9", notes: "knobs turn faster." }
        ]);
    });

    it("orders by version, not by where a version was written", () => {
        const versions = splitPluginChangelog("0.1.2: b 0.1.10: c 0.1.9: a").map((release) => release.version);
        expect(versions).toEqual(["0.1.10", "0.1.9", "0.1.2"]);
    });

    it("leaves a version inside a sentence alone: only one followed by a colon and a space starts an entry", () => {
        const [release] = splitPluginChangelog("0.2.0: needs the desktop app 0.1.120 or later, and 1.2.3:4 is a time.");
        expect(release).toEqual({ version: "0.2.0", notes: "needs the desktop app 0.1.120 or later, and 1.2.3:4 is a time." });
        expect(splitPluginChangelog("0.2.0: needs the desktop app 0.1.120 or later, and 1.2.3:4 is a time.")).toHaveLength(1);
    });

    it("reads a leading v and keeps line breaks out of the way", () => {
        expect(splitPluginChangelog("v1.0.0: first\nv1.0.1:\nsecond")).toEqual([
            { version: "1.0.1", notes: "second" },
            { version: "1.0.0", notes: "first" }
        ]);
    });

    it("keeps text with no version as one entry, and text before the first version last", () => {
        expect(splitPluginChangelog("Faster knobs.")).toEqual([{ version: null, notes: "Faster knobs." }]);
        expect(splitPluginChangelog("Highlights. 0.1.1: one")).toEqual([
            { version: "0.1.1", notes: "one" },
            { version: null, notes: "Highlights." }
        ]);
    });

    it("drops empty versions and joins one written twice", () => {
        expect(splitPluginChangelog("0.1.3: 0.1.2: two 0.1.2: again")).toEqual([{ version: "0.1.2", notes: "two again" }]);
    });

    it("reads nothing from an empty or blank string", () => {
        expect(splitPluginChangelog("")).toEqual([]);
        expect(splitPluginChangelog("   ")).toEqual([]);
    });
});

describe("pluginReleases", () => {
    it("prefers the structured releases, newest first", () => {
        const releases = pluginReleases({
            changelog: "0.1.1: old words",
            releases: [
                { version: "0.1.1", notes: "one" },
                { version: "0.1.2", notes: "two" }
            ]
        });
        expect(releases).toEqual([
            { version: "0.1.2", notes: "two" },
            { version: "0.1.1", notes: "one" }
        ]);
    });

    it("splits the old string for an entry without releases", () => {
        expect(pluginReleases({ changelog: "0.1.2: two 0.1.1: one", releases: [] }).map((release) => release.version)).toEqual(["0.1.2", "0.1.1"]);
        expect(pluginReleases({ changelog: "0.1.1: one" })).toEqual([{ version: "0.1.1", notes: "one" }]);
    });

    it("a catalog entry without releases reads as none, and one with a malformed release is refused", () => {
        const shape = pluginEntrySchema.shape.releases;
        expect(shape.parse(undefined)).toEqual([]);
        expect(shape.safeParse([{ version: "0.1", notes: "x" }]).success).toBe(false);
        expect(shape.safeParse([{ version: "0.1.1", notes: " " }]).success).toBe(false);
    });
});

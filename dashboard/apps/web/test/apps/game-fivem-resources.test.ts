/**
 * What a FiveM server has installed, and what may be fetched into it.
 *
 * The listing is a folder walk turned into rows, and the two things it has to get
 * right are both invisible when wrong: a resource shipping both manifest spellings
 * is one resource and not two, and a resource that the server reports as running
 * but which is not on disk still has to appear - otherwise an operator can see it
 * in their own logs and has no way to stop it.
 *
 * The link check is the other half. It decides what gets downloaded into somebody's
 * server, so it is narrow on purpose: https, and an archive rather than a page.
 */

import { describe, expect, it } from "vitest";
import * as resources from "@/lib/apps/fivem/resources";

const ROOT = "/config/resources/";

describe("a resource name", () => {
    it("is what a folder may be called and nothing wider", () => {
        expect(resources.isResourceName("es_extended")).toBe(true);
        expect(resources.isResourceName("ox-lib.v2")).toBe(true);
        expect(resources.isResourceName("two words")).toBe(false);
        expect(resources.isResourceName("")).toBe(false);
        expect(resources.isResourceName("../escape")).toBe(false);
    });
});

describe("the folder listing", () => {
    it("reads the resource and the bracketed folder above it", () => {
        expect(resources.resourceOfPath(`${ROOT}[gameplay]/mymode/fxmanifest.lua`, ROOT)).toEqual({
            name: "mymode",
            group: "[gameplay]"
        });
    });

    it("has no group for a resource sitting directly under resources", () => {
        expect(resources.resourceOfPath(`${ROOT}polaris/fxmanifest.lua`, ROOT)).toEqual({
            name: "polaris",
            group: null
        });
    });

    it("counts a resource shipping both manifest spellings once", () => {
        const output = [
            `${ROOT}chat/fxmanifest.lua`,
            `${ROOT}chat/__resource.lua`,
            `${ROOT}[gameplay]/mymode/fxmanifest.lua`,
            "",
            "find: /config/resources/nope: No such file or directory"
        ].join("\n");
        expect(resources.parseResourceListing(output, ROOT)).toEqual([
            { name: "chat", group: null },
            { name: "mymode", group: "[gameplay]" }
        ]);
    });
});

describe("folding the two lists", () => {
    it("marks what the server has actually started", () => {
        const rows = resources.foldResources(
            [
                { name: "chat", group: null },
                { name: "mymode", group: "[gameplay]" }
            ],
            ["chat"],
            "polaris"
        );
        expect(rows.map((row) => [row.name, row.running])).toEqual([
            ["chat", true],
            ["mymode", false]
        ]);
    });

    it("still lists something running that is not on disk, so it can be stopped", () => {
        const rows = resources.foldResources([], ["monitor"], "polaris");
        expect(rows).toEqual([{ name: "monitor", group: null, running: true, managed: false }]);
    });

    it("marks the one Polaris installed itself, whatever case it is reported in", () => {
        const rows = resources.foldResources([{ name: "Polaris", group: null }], ["polaris"], "polaris");
        expect(rows[0]).toMatchObject({ managed: true, running: true });
    });

    it("reads the same way twice", () => {
        const first = resources.foldResources(
            [
                { name: "zoo", group: null },
                { name: "aardvark", group: null }
            ],
            [],
            "polaris"
        );
        expect(first.map((row) => row.name)).toEqual(["aardvark", "zoo"]);
    });
});

describe("a link to fetch one from", () => {
    it("takes an archive over https", () => {
        expect(resources.isResourceUrl("https://github.com/x/y/releases/download/v1/res.zip")).toBe(true);
        expect(resources.isResourceUrl("https://example.com/res.tar.gz")).toBe(true);
        expect(resources.isResourceUrl("https://example.com/res.tgz")).toBe(true);
    });

    it("refuses a page, a repository and anything not over https", () => {
        expect(resources.isResourceUrl("https://github.com/x/y")).toBe(false);
        expect(resources.isResourceUrl("http://example.com/res.zip")).toBe(false);
        expect(resources.isResourceUrl("file:///etc/passwd")).toBe(false);
        expect(resources.isResourceUrl("not a url")).toBe(false);
    });
});

describe("the suggested name", () => {
    it("is the archive without its version or its extension", () => {
        expect(resources.resourceNameFromUrl("https://example.com/d/es_extended-1.9.4.zip")).toBe("es_extended");
        expect(resources.resourceNameFromUrl("https://example.com/d/ox_lib.tar.gz")).toBe("ox_lib");
    });

    it("is empty when nothing usable can be read out of the link", () => {
        expect(resources.resourceNameFromUrl("not a url")).toBe("");
        expect(resources.resourceNameFromUrl("https://example.com/")).toBe("");
    });
});

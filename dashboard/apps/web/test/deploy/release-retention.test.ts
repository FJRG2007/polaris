/**
 * Which release images the engine holds that nothing can still want.
 *
 * A production host filled to 99% because every prune leaves release images
 * alone and the only thing that removed them read the database: the pins of
 * failed deploys, cancelled ones and deleted services stayed forever, eight
 * versions of one 1.25 GB image among them. These are the rules that decide what
 * goes when the engine's own listing is the source - and the mistakes they guard
 * against all take a service down: removing what it serves, what a rollback in
 * flight is about to run, or what a deploy has just pinned.
 */

import { shortHash } from "@polaris/deploy";
import { describe, expect, it } from "vitest";
import * as retention from "@/lib/deploy/release-retention";
import type { EngineReleaseImage, RetentionRow } from "@/lib/deploy/release-retention";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const ref = (n: number, service = "shop-web") =>
    `polaris-release/${service}:${n.toString(16).padStart(12, "0")}`;
const image = (n: number, ageMs = DAY, inUse = false): EngineReleaseImage => ({
    ref: ref(n),
    createdAt: NOW - ageMs,
    inUse,
    size: 1_250_000_000
});
const row = (id: string, n: number | null, extra: Partial<RetentionRow> = {}): RetentionRow => ({
    id,
    deployableId: "app-1",
    imageTag: n === null ? null : ref(n),
    status: "removed",
    pinned: false,
    imageKept: true,
    rollbackOfId: null,
    ...extra
});

describe("the window", () => {
    it("keeps the current release and one to roll back to", () => {
        expect(retention.ROLLBACK_WINDOW).toBe(1);
    });
});

describe("what goes", () => {
    it("removes eight old versions down to the two a rollback can use", () => {
        const listed = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => image(n));
        const rows = [8, 7, 6, 5, 4, 3, 2, 1].map((n) =>
            row(`d${n}`, n, { status: n === 8 ? "running" : "removed" })
        );
        const { refs } = retention.protectedReleaseRefs(rows, new Map([["app-1", "d8"]]));
        const gone = retention.releaseImagesToRemove(listed, refs, NOW).map((one) => one.ref);
        expect(gone.sort()).toEqual([1, 2, 3, 4, 5, 6].map((n) => ref(n)).sort());
    });

    it("keeps no rollback target when the disk is running out, only what serves and what is pinned", () => {
        const listed = [1, 2, 3, 4].map((n) => image(n));
        const rows = [
            row("d4", 4, { status: "running" }),
            row("d3", 3),
            row("d2", 2, { pinned: true }),
            row("d1", 1)
        ];
        const { refs } = retention.protectedReleaseRefs(rows, new Map([["app-1", "d4"]]), 0);
        const gone = retention.releaseImagesToRemove(listed, refs, NOW).map((one) => one.ref);
        expect(gone.sort()).toEqual([ref(1), ref(3)].sort());
    });

    it("removes the pin of a failed deploy the database never kept", () => {
        const listed = [image(1), image(2)];
        const rows = [row("d1", 1, { status: "running" })];
        const { refs } = retention.protectedReleaseRefs(rows, new Map([["app-1", "d1"]]));
        expect(retention.releaseImagesToRemove(listed, refs, NOW).map((one) => one.ref)).toEqual([
            ref(2)
        ]);
    });

    it("removes every image of a service that no longer exists", () => {
        const listed = [image(1, DAY, false), image(2, DAY, false)];
        expect(retention.releaseImagesToRemove(listed, new Set(), NOW)).toHaveLength(2);
    });
});

describe("what never goes", () => {
    it("an image any container is on, running or stopped", () => {
        expect(retention.releaseImagesToRemove([image(1, DAY, true)], new Set(), NOW)).toEqual([]);
    });

    it("the image a service is serving, even an old one it was rolled back to", () => {
        const rows = [row("d9", 9), row("d8", 8), row("d1", 1)];
        const { refs } = retention.protectedReleaseRefs(rows, new Map([["app-1", "d1"]]));
        expect(refs.has(ref(1))).toBe(true);
    });

    it("a pinned one, outside the window", () => {
        const rows = [row("d3", 3), row("d2", 2), row("d1", 1, { pinned: true })];
        const { refs } = retention.protectedReleaseRefs(rows, new Map([["app-1", "d3"]]));
        expect([...refs].sort()).toEqual([ref(1), ref(2), ref(3)].sort());
    });

    it("one a running release or canary runs", () => {
        const rows = [
            row("d5", 5),
            row("d4", 4),
            row("d2", 2, { status: "running", imageKept: false })
        ];
        const { refs } = retention.protectedReleaseRefs(rows, new Map([["app-1", "d5"]]));
        expect(refs.has(ref(2))).toBe(true);
        expect(refs.has(ref(4))).toBe(true);
    });

    it("the source of a rollback in flight", () => {
        const rows = [
            row("d9", null, { status: "deploying", imageKept: false, rollbackOfId: "d1" }),
            row("d5", 5),
            row("d1", 1, { imageKept: false })
        ];
        const { refs } = retention.protectedReleaseRefs(rows, new Map([["app-1", "d5"]]));
        expect(refs.has(ref(1))).toBe(true);
    });

    it("the pin of a deploy still in flight, by the tag it will carry", () => {
        const rows = [
            row("11111111-2222-3333-4444-555555555555", null, {
                status: "deploying",
                imageKept: false
            })
        ];
        const { inFlightHashes } = retention.protectedReleaseRefs(rows, new Map());
        expect(inFlightHashes.has(shortHash("11111111-2222-3333-4444-555555555555", 12))).toBe(
            true
        );
    });

    it("an image younger than the grace period", () => {
        expect(
            retention.releaseImagesToRemove([image(1, retention.GRACE_MS - 1)], new Set(), NOW)
        ).toEqual([]);
        expect(
            retention.releaseImagesToRemove([image(1, retention.GRACE_MS)], new Set(), NOW)
        ).toHaveLength(1);
    });

    it("an image whose age the engine would not say", () => {
        expect(
            retention.releaseImagesToRemove([{ ...image(1), createdAt: null }], new Set(), NOW)
        ).toEqual([]);
    });

    it("anything that is not a release image, whatever it is called", () => {
        const odd = { ...image(1), ref: "nginx:latest" };
        expect(retention.releaseImagesToRemove([odd], new Set(), NOW)).toEqual([]);
    });
});

describe("reading the engine", () => {
    it("reads a server listing, and which images a container is on", () => {
        const said = [
            `img|${ref(1)}|2026-10-01 12:00:00 +0000 UTC|1.25GB`,
            `img|${ref(2)}|2026-10-02 12:00:00 +0200 CEST|512MB`,
            "polaris-listed|",
            `ctr|${ref(2)}`,
            "ctr|postgres:16",
            "polaris-ps|"
        ].join("\n");
        expect(retention.parseServerListing(said)).toEqual([
            {
                ref: ref(1),
                createdAt: Date.parse("2026-10-01T12:00:00Z"),
                inUse: false,
                size: 1_250_000_000
            },
            {
                ref: ref(2),
                createdAt: Date.parse("2026-10-02T10:00:00Z"),
                inUse: true,
                size: 512_000_000
            }
        ]);
    });

    it("refuses a listing that did not finish, so nothing is removed on a guess", () => {
        expect(
            retention.parseServerListing(
                `img|${ref(1)}|2026-10-01 12:00:00 +0000 UTC|1GB\npolaris-listed|`
            )
        ).toBeNull();
        expect(retention.parseServerListing("")).toBeNull();
    });

    it("reads the local daemon's df, counting an unknown container count as in use", () => {
        const body = JSON.stringify({
            Images: [
                { RepoTags: [ref(1)], Created: 1_700_000_000, Containers: 0, Size: 10 },
                { RepoTags: [ref(2)], Created: 1_700_000_000, Containers: -1, Size: 10 },
                { RepoTags: ["nginx:latest"], Created: 1_700_000_000, Containers: 0, Size: 10 }
            ]
        });
        expect(retention.parseDfReleaseImages(body)).toEqual([
            { ref: ref(1), createdAt: 1_700_000_000_000, inUse: false, size: 10 },
            { ref: ref(2), createdAt: 1_700_000_000_000, inUse: true, size: 10 }
        ]);
        expect(retention.parseDfReleaseImages("not json")).toBeNull();
    });

    it("reads the engine's dates and sizes", () => {
        expect(retention.parseEngineDate("2026-10-01 12:00:00 -0500 EST")).toBe(
            Date.parse("2026-10-01T17:00:00Z")
        );
        expect(retention.parseEngineDate("yesterday")).toBeNull();
        expect(retention.parseEngineSize("1.25GB")).toBe(1_250_000_000);
        expect(retention.parseEngineSize("0B")).toBe(0);
        expect(retention.parseEngineSize("2GiB")).toBe(2 * 1024 ** 3);
        expect(retention.parseEngineSize("n/a")).toBe(0);
    });
});

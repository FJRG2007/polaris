/**
 * How many builds of one service a host holds.
 *
 * Five, and three of them running, which is how a machine fills up without
 * anybody doing anything: one service deployed a handful of times sat on five
 * copies of a 1.8 GB image - nine gigabytes of builds nobody had asked to keep
 * and no screen ever mentioned - and a service that keeps its history ran three
 * containers where one was being used.
 *
 * So: the live one, and whatever somebody pinned. Pinning is a person saying
 * "this one stays"; everything else goes as its successor is promoted, and
 * reaching further back is a build rather than a restart.
 */

import { describe, expect, it } from "vitest";
import { ROLLBACK_WINDOW } from "@/lib/deploy-service";
import { KEPT_RELEASES, imagesOutsideWindow } from "@/lib/deploy/releases";

const tag = (n: number) => `polaris-release/app:${n}`;
const row = (id: string, n: number, pinned = false) => ({ id, imageTag: tag(n), pinned });

describe("what is kept", () => {
    it("keeps no image besides the live one", () => {
        expect(ROLLBACK_WINDOW).toBe(0);
    });

    it("keeps one release running", () => {
        expect(KEPT_RELEASES).toBe(1);
    });
});

describe("what that means for a service deployed a few times", () => {
    const rows = [row("d5", 5), row("d4", 4), row("d3", 3), row("d2", 2), row("d1", 1)];

    it("drops every image but the one serving", () => {
        expect(imagesOutsideWindow(rows, "d5", ROLLBACK_WINDOW)).toEqual([
            tag(4),
            tag(3),
            tag(2),
            tag(1)
        ]);
    });

    it("keeps the one somebody pinned", () => {
        const pinned = [row("d5", 5), row("d4", 4, true), row("d3", 3)];
        expect(imagesOutsideWindow(pinned, "d5", ROLLBACK_WINDOW)).toEqual([tag(3)]);
    });

    it("keeps the image a rollback is currently serving, not the newest build", () => {
        // Rolled back: the live deployment is an older row, and its image is the
        // one that must not be taken out from under it.
        expect(imagesOutsideWindow(rows, "d2", ROLLBACK_WINDOW)).not.toContain(tag(2));
    });

    it("takes nothing when there is one build", () => {
        expect(imagesOutsideWindow([row("d1", 1)], "d1", ROLLBACK_WINDOW)).toEqual([]);
    });
});

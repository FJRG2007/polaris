/**
 * Which kept release images a service holds on to, and which it lets go.
 *
 * A rollback is instant only while the image is on the server, and a server
 * that keeps every image fills up. The window decides between the two, and the
 * mistakes it can make are both expensive: removing the image the live release
 * runs takes the service down on its next restart, and removing an image a
 * rollback shares with an older row pulls it out from under the newer one.
 */

import { describe, expect, it } from "vitest";
import { imagesOutsideWindow } from "@/lib/deploy/releases";
import { PRUNE_EVERY_ENGINE } from "@/lib/deploy/server-space";

const tag = (n: number) => `polaris-release/web-1a2b:${n.toString(16).padStart(12, "0")}`;
const row = (id: string, image: number, pinned = false) => ({ id, imageTag: tag(image), pinned });

describe("the rollback window", () => {
    it("keeps the newest few and lets the older ones go", () => {
        const rows = [1, 2, 3, 4, 5, 6, 7].reverse().map((n) => row(`d${n}`, n));
        expect(imagesOutsideWindow(rows, "d7", 3)).toEqual([tag(3), tag(2), tag(1)]);
    });

    it("never lets go of the image the live release runs, however old it is", () => {
        // A rollback to an old release makes its image the live one again.
        const rows = [row("d9", 9), row("d8", 8), row("d7", 7), row("d1", 1)];
        expect(imagesOutsideWindow(rows, "d1", 2)).toEqual([tag(7)]);
    });

    it("keeps a pinned one outside the window and does not count it against it", () => {
        const rows = [row("d4", 4), row("d3", 3), row("d2", 2), row("d1", 1, true)];
        expect(imagesOutsideWindow(rows, "d4", 1)).toEqual([tag(2)]);
    });

    it("counts one image once, so a rollback does not lose the image it shares", () => {
        // d5 rolled back to d2's image: two rows, one image.
        const rows = [row("d5", 2), row("d4", 4), row("d3", 3), row("d2", 2)];
        const gone = imagesOutsideWindow(rows, "d5", 1);
        expect(gone).not.toContain(tag(2));
        expect(gone).toEqual([tag(3)]);
    });

    it("asks nothing to be removed when there is nothing outside it", () => {
        expect(imagesOutsideWindow([row("d1", 1)], "d1", 5)).toEqual([]);
        expect(imagesOutsideWindow([], null, 5)).toEqual([]);
    });
});

describe("a remote server's tidy-up", () => {
    it("leaves the kept release images alone", () => {
        // `-a` takes every image no container is on, which a kept version is.
        expect(PRUNE_EVERY_ENGINE).toContain("docker system prune -af --filter 'label!=polaris.release'");
    });
});

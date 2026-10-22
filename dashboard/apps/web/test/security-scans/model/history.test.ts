/**
 * The scan history keeps image and dependency scans per subject (an image id,
 * an app), so a server with many images or apps never pushes one's only scan
 * out and rescans it forever. Every other kind keeps its newest per server.
 */

import { describe, expect, it } from "vitest";
import * as history from "@polaris-app/security-scans/src/model/history";

const imageId = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

function rows(
    count: number,
    make: (i: number) => Omit<history.HistoryRow, "id">
): history.HistoryRow[] {
    return Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, ...make(i) }));
}

describe("pruneVictims", () => {
    it("keeps one scan of each of many images", () => {
        const scans = rows(80, (i) => ({ kind: "image", imageId: imageId(i), input: "{}" }));
        expect(history.pruneVictims(scans)).toEqual([]);
    });

    it("keeps only the newest scans of one image", () => {
        const scans = rows(8, () => ({ kind: "image", imageId: imageId(1), input: "{}" }));
        expect(history.pruneVictims(scans)).toEqual(["row-5", "row-6", "row-7"]);
    });

    it("keeps each app's dependency scans apart", () => {
        const busy = rows(40, () => ({
            kind: "deps",
            imageId: null,
            input: JSON.stringify({ applicationId: "app-busy" })
        }));
        const quiet = {
            id: "quiet",
            kind: "deps",
            imageId: null,
            input: JSON.stringify({ applicationId: "app-quiet" })
        };
        const victims = history.pruneVictims([...busy, quiet]);
        expect(victims).not.toContain("quiet");
        expect(victims).toHaveLength(40 - history.KEEP_PER_SUBJECT);
    });

    it("keeps the newest per server for a kind with no subject", () => {
        const scans = rows(35, () => ({ kind: "audit", imageId: null, input: "{}" }));
        expect(history.pruneVictims(scans)).toHaveLength(35 - history.KEEP_PER_KIND);
    });
});

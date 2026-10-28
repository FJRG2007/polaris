/**
 * The Updates card's line about Polaris's own images: only what scans found,
 * the newest scan per image reference. Rows below are fixture data.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { currentScan, summarizeOwnScans } from "@/lib/security/own-images";

const at = (day: number) => new Date(Date.UTC(2026, 0, day));

describe("own image vulnerabilities", () => {
    it("says nothing when no scan of Polaris's images ran", () => {
        expect(summarizeOwnScans([])).toBeNull();
    });

    const ID_OLD = `sha256:${"1".repeat(64)}`;
    const ID_NEW = `sha256:${"2".repeat(64)}`;
    const row = (
        label: string,
        state: string,
        imageId: string | null,
        summary: string,
        finishedAt: Date | null
    ) => ({ label, state, imageId, summary, finishedAt });

    it("counts the newest scan of each image once", () => {
        const summary = summarizeOwnScans([
            row("fixture/polaris-web:latest", "done", ID_NEW, '{"critical":0,"high":1}', at(9)),
            row("fixture/polaris-sidecar:latest", "done", null, '{"critical":2,"high":3}', at(8)),
            row("fixture/polaris-web:latest", "done", ID_OLD, '{"critical":9,"high":9}', at(1)),
            row("fixture/broken", "done", null, "not json", null)
        ]);
        expect(summary).toEqual({
            images: 3,
            critical: 2,
            high: 4,
            failed: 0,
            scannedAt: at(8).toISOString()
        });
    });

    it("counts a part of Polaris once across the release tags of its builds", () => {
        const relay = '{"applicationIds":["fixture-relay"],"part":"fixture-relay"}';
        const summary = summarizeOwnScans([
            {
                ...row("fixture/relay:build-2", "done", ID_NEW, '{"critical":0,"high":1}', at(9)),
                input: relay
            },
            {
                ...row("fixture/relay:build-1", "done", ID_OLD, '{"critical":5,"high":5}', at(2)),
                input: relay
            }
        ]);
        expect(summary).toMatchObject({ images: 1, critical: 0, high: 1 });
    });

    it("never counts a replaced image when the scans of the new one failed", () => {
        const summary = summarizeOwnScans([
            row("fixture/polaris-hostd:latest", "failed", ID_NEW, "{}", at(9)),
            row("fixture/polaris-hostd:latest", "failed", ID_NEW, "{}", at(8)),
            row("fixture/polaris-hostd:latest", "done", ID_OLD, '{"critical":4,"high":12}', at(2))
        ]);
        expect(summary).toEqual({ images: 0, critical: 0, high: 0, failed: 1, scannedAt: null });
    });

    it("counts the images that scanned and names the ones that failed", () => {
        const summary = summarizeOwnScans([
            row("fixture/polaris-hostd:latest", "failed", ID_NEW, "{}", at(9)),
            row("fixture/polaris-web:latest", "done", ID_OLD, '{"critical":0,"high":2}', at(8)),
            row("fixture/polaris-hostd:latest", "done", ID_OLD, '{"critical":4,"high":12}', at(2))
        ]);
        expect(summary).toMatchObject({ images: 1, critical: 0, high: 2, failed: 1 });
    });

    it("keeps the same image's result while it is scanned again", () => {
        const rows = [
            row("fixture/polaris-web:latest", "running", ID_NEW, "{}", null),
            row("fixture/polaris-web:latest", "done", ID_NEW, '{"critical":1,"high":0}', at(5))
        ];
        expect(currentScan(rows)).toBe(rows[1]);
        expect(summarizeOwnScans(rows)).toMatchObject({ images: 1, critical: 1, failed: 0 });
    });

    it("shows nothing for a new image still waiting for its first scan", () => {
        const rows = [
            row("fixture/polaris-web:latest", "queued", ID_NEW, "{}", null),
            row("fixture/polaris-web:latest", "done", ID_OLD, '{"critical":7,"high":7}', at(5))
        ];
        expect(currentScan(rows)).toBeNull();
        expect(summarizeOwnScans(rows)).toBeNull();
    });
});

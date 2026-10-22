/**
 * The Updates card's line about Polaris's own images: only what scans found,
 * the newest scan per image reference. Rows below are fixture data.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { summarizeOwnScans } from "@/lib/security/own-images";

const at = (day: number) => new Date(Date.UTC(2026, 0, day));

describe("own image vulnerabilities", () => {
    it("says nothing when no scan of Polaris's images ran", () => {
        expect(summarizeOwnScans([])).toBeNull();
    });

    it("counts the newest scan of each image once", () => {
        const summary = summarizeOwnScans([
            { label: "fixture/polaris-web:latest", summary: '{"critical":0,"high":1}', finishedAt: at(9) },
            { label: "fixture/polaris-sidecar:latest", summary: '{"critical":2,"high":3}', finishedAt: at(8) },
            { label: "fixture/polaris-web:latest", summary: '{"critical":9,"high":9}', finishedAt: at(1) },
            { label: "fixture/broken", summary: "not json", finishedAt: null }
        ]);
        expect(summary).toEqual({
            images: 3,
            critical: 2,
            high: 4,
            scannedAt: at(8).toISOString()
        });
    });
});

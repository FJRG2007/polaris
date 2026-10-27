/**
 * Image findings where they are acted on: a stored scan row read for the
 * screens (counts, a state the code knows, an error that is a key and nothing
 * else), and Polaris's own images taken newest scan per reference. Rows below
 * are fixture data.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { newestPerRef, scanView } from "@/lib/security/image-findings";

const row = (over: Partial<Parameters<typeof scanView>[0]> = {}) => ({
    id: "fixture-scan",
    state: "done",
    error: null,
    summary: JSON.stringify({ critical: 2, high: 1, medium: 0, low: 4, total: 9, sbom: true }),
    createdAt: new Date(Date.UTC(2026, 0, 2)),
    finishedAt: new Date(Date.UTC(2026, 0, 2, 0, 5)),
    ...over
});

describe("scanView", () => {
    it("reads the counts a finished scan stored", () => {
        const view = scanView(row());
        expect(view?.counts).toEqual({ critical: 2, high: 1, medium: 0, low: 4 });
        expect(view?.total).toBe(9);
        expect(view?.finishedAt).toBe("2026-01-02T00:05:00.000Z");
    });

    it("treats a summary that does not parse as all zero", () => {
        expect(scanView(row({ summary: "not json" }))?.counts).toEqual({
            critical: 0,
            high: 0,
            medium: 0,
            low: 0
        });
        expect(scanView(row({ summary: JSON.stringify({ critical: -3 }) }))?.counts.critical).toBe(
            0
        );
    });

    it("drops a state it does not know and an error that is not a key", () => {
        expect(scanView(row({ state: "exploded" }))).toBeNull();
        expect(scanView(row({ state: "failed", error: "noRoom" }))?.error).toBe("noRoom");
        expect(scanView(row({ state: "failed", error: "/var/lib/docker: denied" }))?.error).toBe(
            null
        );
    });
});

describe("newestPerRef", () => {
    it("keeps the first (newest) scan of each reference", () => {
        const rows = [
            { label: "fixture/web:2", id: "a" },
            { label: "fixture/hostd:2", id: "b" },
            { label: "fixture/web:2", id: "c" }
        ];
        expect(newestPerRef(rows).map((r) => r.id)).toEqual(["a", "b"]);
        expect(newestPerRef([])).toEqual([]);
    });
});

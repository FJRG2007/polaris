/**
 * Image findings where they are acted on: a stored scan row read for the
 * screens (counts, a state the code knows, an error that is a key and nothing
 * else), and Polaris's own images taken newest scan per reference. Rows below
 * are fixture data.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { scanView } from "@/lib/security/image-findings";
import { newestPerRef } from "@/lib/security/own-images";

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

    it("keeps one scan of a part of Polaris whatever tag each build gave it", () => {
        const input = '{"applicationIds":["fixture-relay"],"part":"fixture-relay"}';
        const rows = [
            { label: "fixture/relay:build-2", input, id: "new" },
            { label: "fixture/relay:build-1", input, id: "old" }
        ];
        expect(newestPerRef(rows).map((r) => r.id)).toEqual(["new"]);
    });

    it("keeps apart two images one part of Polaris runs", () => {
        const input = '{"applicationIds":["fixture-relay"],"part":"fixture-relay"}';
        const rows = [
            { label: "fixture/socat:1.8@sha256:" + "a".repeat(64), input, id: "forwarder" },
            { label: "fixture/relay:build-2", input, id: "relay" },
            { label: "fixture/relay:build-1", input, id: "older" }
        ];
        expect(newestPerRef(rows).map((r) => r.id)).toEqual(["forwarder", "relay"]);
    });

    it("keeps apart two core images an app shares with Polaris", () => {
        const input = '{"applicationIds":["fixture-app"]}';
        const rows = [
            { label: "fixture/postgres:16", input, id: "db" },
            { label: "fixture/redis:7", input, id: "cache" }
        ];
        expect(newestPerRef(rows).map((r) => r.id)).toEqual(["db", "cache"]);
    });

    it("keeps a newer failed scan over an older image's finished one", () => {
        const rows = [
            { label: "fixture/hostd:latest", id: "new", state: "failed" },
            { label: "fixture/hostd:latest", id: "old", state: "done" }
        ];
        expect(newestPerRef(rows).map((r) => [r.id, r.state])).toEqual([["new", "failed"]]);
    });
});

/**
 * Management lists Polaris's own images on every server, not only the machine
 * it runs on: the edge Polaris runs on a remote server is as much its own, and
 * Apps > Security scans no longer shows it. The same reference on two servers
 * is two rows, each saying where it runs; only this machine's daemon is asked
 * which images still run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
const running = vi.hoisted(() => ({ value: null as ReadonlySet<string> | null, asked: 0 }));

vi.mock("@polaris/db", () => ({
    prisma: { securityScan: { findMany: async () => rows.value } }
}));
vi.mock("@/lib/security/own-images", async (original) => ({
    ...(await original<typeof import("@/lib/security/own-images")>()),
    runningImageIds: async () => {
        running.asked += 1;
        return running.value;
    }
}));

import { ownImages } from "@/lib/security/image-findings";

const LOCAL_ID = `sha256:${"a".repeat(64)}`;
const GONE_ID = `sha256:${"b".repeat(64)}`;
const REMOTE_ID = `sha256:${"c".repeat(64)}`;

function scan(id: string, target: { kind: string; name: string }, targetId: string, imageId: string, label: string) {
    return {
        id,
        state: "done",
        error: null,
        summary: JSON.stringify({ critical: 1, high: 2, medium: 0, low: 0, total: 3 }),
        createdAt: new Date("2026-11-14T04:43:29Z"),
        finishedAt: new Date("2026-11-14T04:45:00Z"),
        label,
        input: JSON.stringify({ imageId, ref: label, users: ["traefik"] }),
        imageId,
        targetId,
        target
    };
}

beforeEach(() => {
    running.asked = 0;
});

describe("Polaris's own images in Management", () => {
    it("lists a remote server's Polaris images beside this machine's, each saying where", async () => {
        running.value = new Set([LOCAL_ID]);
        rows.value = [
            scan("00000000-0000-4000-8000-000000000001", { kind: "local", name: "Local" }, "t-local", LOCAL_ID, "traefik:v3.1"),
            scan("00000000-0000-4000-8000-000000000002", { kind: "ssh", name: "ionos" }, "t-ionos", REMOTE_ID, "traefik:v3.1")
        ];
        const images = await ownImages(new Date("2026-11-15T00:00:00Z"));
        expect(images.map((image) => [image.ref, image.server])).toEqual(
            expect.arrayContaining([
                ["traefik:v3.1", null],
                ["traefik:v3.1", "ionos"]
            ])
        );
        expect(images).toHaveLength(2);
    });

    it("drops a replaced image only on this machine, and only asks this machine's daemon", async () => {
        running.value = new Set([LOCAL_ID]);
        rows.value = [
            scan("00000000-0000-4000-8000-000000000003", { kind: "local", name: "Local" }, "t-local", GONE_ID, "traefik:v3.0"),
            scan("00000000-0000-4000-8000-000000000004", { kind: "ssh", name: "ionos" }, "t-ionos", REMOTE_ID, "traefik:v3.1")
        ];
        const images = await ownImages(new Date("2026-11-15T00:00:00Z"));
        expect(images.map((image) => image.server)).toEqual(["ionos"]);
        expect(running.asked).toBe(1);
    });

    it("never asks the daemon when no scan is of this machine", async () => {
        rows.value = [
            scan("00000000-0000-4000-8000-000000000005", { kind: "ssh", name: "ionos" }, "t-ionos", REMOTE_ID, "traefik:v3.1")
        ];
        await ownImages(new Date("2026-11-15T00:00:00Z"));
        expect(running.asked).toBe(0);
    });
});

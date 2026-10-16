/**
 * Security scans is part of every Polaris, so its once-a-minute job runs on
 * instances where nobody has ever opened the screen. With nothing configured it
 * must stay idle: a few reads of its own tables, no server dialled, no
 * container started, and nothing written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const reads: string[] = [];
const writes: string[] = [];

/** A model whose reads answer "nothing here" and whose writes are recorded. */
function emptyModel(name: string) {
    const read = (answer: unknown) => async () => {
        reads.push(name);
        return answer;
    };
    const write = (method: string, answer: unknown) => async () => {
        writes.push(`${name}.${method}`);
        return answer;
    };
    return {
        findMany: read([]),
        findFirst: read(null),
        findUnique: read(null),
        groupBy: read([]),
        count: read(0),
        updateMany: read({ count: 0 }),
        deleteMany: read({ count: 0 }),
        create: write("create", {}),
        update: write("update", {}),
        upsert: write("upsert", {})
    };
}

vi.mock("@polaris/db", () => ({
    prisma: new Proxy({}, { get: (_target, model: string) => emptyModel(model) })
}));

const dialled = vi.hoisted(() => [] as string[]);
vi.mock("@polaris-app/security-scans/src/lib/runner", () => {
    const dial = (name: string) => async () => {
        dialled.push(name);
        throw new Error(`${name} should not run on an idle instance`);
    };
    return {
        exportImage: dial("exportImage"),
        listExports: dial("listExports"),
        portsFor: dial("portsFor"),
        removeExport: dial("removeExport"),
        runHostAction: dial("runHostAction"),
        runOneShot: dial("runOneShot"),
        ScanFailure: class ScanFailure extends Error {},
        TIMEOUT_MS: 60 * 60_000
    };
});

const { tick } = await import("@polaris-app/security-scans/src/lib/service");

describe("security scans job with nothing configured", () => {
    beforeEach(() => {
        reads.length = 0;
        writes.length = 0;
        dialled.length = 0;
    });

    it("reads its own tables and does nothing else", async () => {
        await tick();
        expect(dialled).toEqual([]);
        expect(writes).toEqual([]);
        expect(new Set(reads)).toEqual(new Set(["securityScan", "securitySetting", "securityQuarantine"]));
    });

    it("never lists the servers when no image scan ran on any of them", async () => {
        await tick();
        await tick();
        expect(reads).not.toContain("deployTarget");
        expect(dialled).toEqual([]);
    });
});

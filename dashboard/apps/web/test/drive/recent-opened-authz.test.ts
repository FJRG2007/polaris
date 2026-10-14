/**
 * "Recently opened" is built from the reader's own download history, which
 * outlives their access: a folder they opened last week may be denied to them
 * today. Every path in that history is checked again, so a revoked folder stops
 * naming its files in the list.
 */

import { describe, expect, it, vi } from "vitest";

const AT = new Date("2026-01-01T00:00:00Z");

const auditRows = [
    { metadata: JSON.stringify({ path: "team/hr/payroll.xlsx" }), at: AT },
    { metadata: JSON.stringify({ path: "team/notes.txt" }), at: AT }
];

const driver = {
    stat: async (path: string) => ({ path, kind: "file", size: 1n, modifiedAt: AT }),
    list: async () => ({ entries: [] }),
    dispose: async () => undefined
};

vi.mock("@/lib/api-session", () => ({ apiUser: async () => ({ id: "reader-1" }) }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => true }));
vi.mock("@polaris/db", () => ({ prisma: { auditLog: { findMany: async () => auditRows } } }));
vi.mock("@/lib/storage-service", () => ({
    getDriverForConnection: async () => driver,
    SmbShareRequiredError: class extends Error {}
}));
vi.mock("@/lib/access-lock-service", () => ({ listLocks: async () => [] }));
vi.mock("@/lib/drive-meta-service", () => ({ getMetaMap: async () => new Map() }));
vi.mock("@/lib/drive-authz", () => ({
    authorizeDrive: async () => undefined,
    drivePathFilter: async () => async (path: string) => !path.startsWith("team/hr"),
    DriveAccessError: class extends Error {},
    DriveLockedError: class extends Error {}
}));

const route = await import("../../src/app/api/drive/recent/route");

describe("recently opened files", () => {
    it("leaves out a file in a folder the reader can no longer open", async () => {
        const answer = await route.GET(
            new Request("http://localhost/api/drive/recent?c=c1&by=opened")
        );
        const body = (await answer.json()) as { entries: Array<{ path: string }> };
        expect(body.entries.map((entry) => entry.path)).toEqual(["team/notes.txt"]);
    });
});

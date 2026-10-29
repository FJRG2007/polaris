/**
 * What reading a file records.
 *
 * The activity feed said "Downloaded" under a picture somebody had only uploaded
 * and looked at: the preview, a video tile's frame and every seek of a video all
 * went through the download route and were recorded as downloads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recordAudit = vi.fn(async () => undefined);

vi.mock("@/lib/api-session", () => ({ apiUser: async () => ({ id: "reader-1", isAdmin: false }) }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => true }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/download-ticket", () => ({
    downloadTicketCookie: () => "",
    validDownloadTicket: () => false
}));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: class extends Error {},
    DriveLockedError: class extends Error {},
    requireDriveDriver: async () => ({
        capabilities: { randomRead: true },
        stat: async () => ({ kind: "file", size: 100n, mime: "image/png" }),
        readStream: async () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        dispose: async () => undefined
    })
}));

const route = await import("../../src/app/api/drive/download/route");

function read(query: string, range?: string): Promise<Response> {
    return route.GET(
        new Request(`https://polaris.test/api/drive/download?c=conn-1&p=a.png${query}`, {
            headers: range ? { range } : {}
        })
    );
}

function recorded(): unknown[] {
    return recordAudit.mock.calls.map((call) => (call as unknown[])[0]);
}

beforeEach(() => {
    recordAudit.mockClear();
});

describe("reading a drive file", () => {
    it("records a real download as a download", async () => {
        await read("");
        expect(recorded()).toEqual([expect.objectContaining({ action: "drive.download" })]);
    });

    it("records a preview as a view", async () => {
        await read("&disposition=inline");
        expect(recorded()).toEqual([expect.objectContaining({ action: "drive.view" })]);
    });

    it("records a video's first range once and not its seeks", async () => {
        await read("&disposition=inline", "bytes=0-");
        await read("&disposition=inline", "bytes=50-");
        expect(recorded()).toHaveLength(1);
    });

    it("records nothing for a tile's thumbnail frame", async () => {
        await read("&disposition=inline&purpose=thumbnail", "bytes=0-");
        expect(recorded()).toEqual([]);
    });
});

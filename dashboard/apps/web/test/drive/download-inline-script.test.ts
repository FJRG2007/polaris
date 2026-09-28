/**
 * A file opened from a storage is served from Polaris's own origin, and a file
 * on a shared storage was put there by somebody else. An HTML or SVG file opened
 * inline must render in a sandbox and never be sniffed into markup, or it runs
 * with the session of whoever opened it. A PDF keeps rendering.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stat = vi.fn();

vi.mock("@/lib/api-session", () => ({ apiUser: async () => ({ id: "reader-1", isAdmin: false }) }));
vi.mock("@/lib/session", () => ({ sessionCan: async () => true }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/drive/download-ticket", () => ({
    downloadTicketCookie: () => "",
    validDownloadTicket: () => false
}));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: class extends Error {},
    DriveLockedError: class extends Error {},
    requireDriveDriver: async () => ({
        capabilities: { randomRead: false },
        stat,
        readStream: async () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        dispose: async () => undefined
    })
}));

const route = await import("../../src/app/api/drive/download/route");

function open(path: string): Promise<Response> {
    return route.GET(
        new Request(
            `https://polaris.test/api/drive/download?c=conn-1&p=${encodeURIComponent(path)}&disposition=inline`
        )
    );
}

beforeEach(() => {
    stat.mockReset();
});

describe("a drive file opened inline", () => {
    for (const [name, mime] of [
        ["page.html", "text/html"],
        ["drawing.svg", null]
    ] as const) {
        it(`serves ${name} sandboxed and unsniffed`, async () => {
            stat.mockResolvedValue({ kind: "file", size: 10n, mime });
            const answer = await open(name);
            expect(answer.status).toBe(200);
            expect(answer.headers.get("content-security-policy")).toBe("sandbox");
            expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
        });
    }

    it("leaves a PDF out of the sandbox so the browser still draws it", async () => {
        stat.mockResolvedValue({ kind: "file", size: 10n, mime: null });
        const answer = await open("report.pdf");
        expect(answer.headers.get("content-type")).toBe("application/pdf");
        expect(answer.headers.get("content-security-policy")).toBeNull();
        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    });
});

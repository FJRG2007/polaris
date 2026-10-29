/**
 * The pictures on a shared folder's tiles.
 *
 * A visitor scrolling past an album has not downloaded or viewed any of it, so
 * what is pinned here is that a tile's picture - drawn by the share's thumbnail
 * route, or a frame the browser takes out of a video through the download route
 * - is neither counted against the link's cap nor written to its visit log,
 * while staying inside the shared folder and behind the link's preview switch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here" })
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/storage", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://example.test" }));
vi.mock("@/lib/link-visitor", () => ({ linkVisitorId: async () => null, linkVisitorSelect: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

interface FakeShare {
    id: string;
    path: string;
    connectionId: string;
    allowPreview: boolean;
    allowDownload: boolean;
    maxDownloads: number | null;
}

let share: FakeShare;
const gateShareRequest = vi.fn(async () => ({
    ok: true as const,
    share,
    ip: "198.51.100.7",
    ipHash: "ip",
    userAgentHash: "ua"
}));
vi.mock("@/lib/share-access", () => ({ gateShareRequest }));

const registerDownload = vi.fn(async () => true);
const logShareAccess = vi.fn(async () => undefined);
vi.mock("@/lib/share-service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/share-service")>()),
    registerDownload,
    logShareAccess
}));

const readStream = vi.fn(
    async () =>
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
            }
        })
);
const driver = {
    capabilities: { randomRead: true },
    stat: vi.fn(async (path: string) => ({
        kind: "file",
        size: 3n,
        modifiedAt: new Date("2026-10-01T00:00:00.000Z"),
        mime: null,
        path
    })),
    readStream,
    dispose: vi.fn(async () => undefined)
};
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection: async () => driver }));

const thumbnailFor = vi.fn(async () => Buffer.from([9, 9]));
vi.mock("@/lib/drive-thumbnail", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/drive-thumbnail")>()),
    thumbnailFor
}));

const thumbnailRoute = await import("../../src/app/api/s/[token]/thumbnail/route");
const downloadRoute = await import("../../src/app/api/s/[token]/download/route");

const params = { params: Promise.resolve({ token: "t" }) };
const thumbnail = (path: string) =>
    thumbnailRoute.GET(
        new Request(`http://localhost/api/s/t/thumbnail?p=${encodeURIComponent(path)}&v=1`),
        params
    );
const download = (path: string, extra = "") =>
    downloadRoute.GET(
        new Request(
            `http://localhost/api/s/t/download?p=${encodeURIComponent(path)}&disposition=inline${extra}`
        ),
        params
    );

beforeEach(() => {
    share = {
        id: "s1",
        path: "Album",
        connectionId: "c1",
        allowPreview: true,
        allowDownload: false,
        maxDownloads: null
    };
    vi.clearAllMocks();
});

describe("a shared folder's thumbnail", () => {
    it("is drawn without being counted or logged", async () => {
        const answer = await thumbnail("Album/IMG_1.jpg");
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-type")).toBe("image/webp");
        expect(thumbnailFor).toHaveBeenCalledTimes(1);
        expect(registerDownload).not.toHaveBeenCalled();
        expect(logShareAccess).not.toHaveBeenCalled();
    });

    it("cannot reach outside the shared folder", async () => {
        const answer = await thumbnail("Other/IMG_1.jpg");
        expect(answer.status).toBe(400);
        expect(driver.stat).not.toHaveBeenCalled();
    });

    it("is refused on a link with previews switched off", async () => {
        share.allowPreview = false;
        const answer = await thumbnail("Album/IMG_1.jpg");
        expect(answer.status).toBe(403);
        expect(driver.stat).not.toHaveBeenCalled();
    });

    it("keeps the icon for a file it cannot draw", async () => {
        const answer = await thumbnail("Album/notes.txt");
        expect(answer.status).toBe(404);
        expect(driver.stat).not.toHaveBeenCalled();
    });
});

describe("a frame taken out of a shared video", () => {
    it("is read without being counted or logged", async () => {
        const answer = await download("Album/clip.mp4", "&purpose=thumbnail");
        expect(answer.status).toBe(200);
        expect(registerDownload).not.toHaveBeenCalled();
        expect(logShareAccess).not.toHaveBeenCalled();
    });

    it("is only a video: anything else asked this way is refused", async () => {
        const answer = await download("Album/report.pdf", "&purpose=thumbnail");
        expect(answer.status).toBe(404);
        expect(readStream).not.toHaveBeenCalled();
    });

    it("is refused on a link with a download cap, which it would get around", async () => {
        share.maxDownloads = 3;
        const answer = await download("Album/clip.mp4", "&purpose=thumbnail");
        expect(answer.status).toBe(404);
        expect(readStream).not.toHaveBeenCalled();
    });

    it("still needs previews: a link with them off refuses it", async () => {
        share.allowPreview = false;
        const answer = await download("Album/clip.mp4", "&purpose=thumbnail");
        expect(answer.status).toBe(403);
        expect(readStream).not.toHaveBeenCalled();
    });

    it("leaves an ordinary preview counted and logged as before", async () => {
        const answer = await download("Album/clip.mp4");
        expect(answer.status).toBe(200);
        expect(registerDownload).toHaveBeenCalledTimes(1);
        expect(logShareAccess).toHaveBeenCalledTimes(1);
    });
});

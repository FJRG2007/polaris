/**
 * Handing back an attachment's bytes.
 *
 * The handler returns while the body is still to be read, so the driver's
 * lifetime belongs to the stream rather than to the function: an SFTP or SMB
 * session returned in a `finally` is returned before the first byte moves, and
 * the download dies on exactly the backends that pool their connections.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "018f2b7a-0000-7000-8000-0000000000e1";
const CIPHER = "018f2b7a-0000-7000-8000-0000000000e2";
const ATTACHMENT = "018f2b7a-0000-7000-8000-0000000000e3";

const dispose = vi.fn(async () => undefined);
const readStream = vi.fn();
const attachmentFindFirst = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        vaultAttachment: {
            findFirst: attachmentFindFirst,
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn()
        }
    }
}));
vi.mock("@/lib/vault/blobs", () => ({
    MAX_BLOB_BYTES: 500 * 1024 * 1024,
    vaultBlobDriver: async () => ({ readStream, dispose }),
    vaultBlobPath: () => "polaris/vault/attachment/x",
    writeVaultBlob: vi.fn(),
    deleteVaultBlob: vi.fn()
}));
vi.mock("@/lib/vault/ciphers", () => ({ getCipher: vi.fn(async () => ({ id: CIPHER })) }));
vi.mock("@/lib/vault/account", () => ({ bumpRevision: vi.fn(async () => undefined) }));
vi.mock("@/lib/vault/auth", () => ({
    vaultError: (message: string, status: number) =>
        Response.json({ message, object: "error" }, { status })
}));

const attachments = await import("../../src/lib/vault/api/attachments");

function context() {
    return {
        request: new Request(
            `https://polaris.test/vault/api/ciphers/${CIPHER}/attachment/${ATTACHMENT}`
        ),
        params: { id: CIPHER, attachmentId: ATTACHMENT },
        principal: { userId: USER, email: "someone@polaris.test", device: null },
        query: new URLSearchParams()
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    attachmentFindFirst.mockResolvedValue({
        storedPath: "polaris/vault/attachment/a/1",
        size: BigInt(4)
    });
});

describe("download", () => {
    it("keeps the driver alive until the body has been read", async () => {
        readStream.mockResolvedValue(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3, 4]));
                    controller.close();
                }
            })
        );

        const response = await attachments.download(context());
        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).toBe("4");
        // The session is still open here: the bytes have not moved yet.
        expect(dispose).not.toHaveBeenCalled();

        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("gives the session back when the reader walks away mid-file", async () => {
        readStream.mockResolvedValue(
            new ReadableStream<Uint8Array>({
                pull(controller) {
                    controller.enqueue(new Uint8Array([7]));
                }
            })
        );

        const response = await attachments.download(context());
        const reader = response.body?.getReader();
        await reader?.read();
        expect(dispose).not.toHaveBeenCalled();
        await reader?.cancel();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("gives the session back when the file cannot be opened at all", async () => {
        readStream.mockRejectedValue(new Error("gone"));
        const response = await attachments.download(context());
        expect(response.status).toBe(404);
        expect(dispose).toHaveBeenCalledTimes(1);
    });
});

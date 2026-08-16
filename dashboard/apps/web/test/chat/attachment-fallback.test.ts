/**
 * What a message records about where its file went.
 *
 * The placement itself - write it, prove it readable, fall through to this
 * server when the storage will not keep it - is one function shared with profile
 * photos, and it is pinned next door in `admin/storage-fallback`. What is this
 * module's own is the row: an attachment reads back from the storage named on
 * it, so a file that landed on this server while the row says NAS is a broken
 * download with an extra step.
 *
 * And the sentence a refusal turns into. "That could not be sent" for a storage
 * that would not keep the bytes sends whoever reads it looking at the browser,
 * at the network and at the message - anywhere but at the disk.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NAS = "018f2b7a-0000-7000-8000-0000000000f1";
const CHANNEL = "018f2b7a-0000-7000-8000-0000000000c1";

const placeFile = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: { chatAttachment: { findUnique: vi.fn(), findMany: vi.fn(async () => []) } }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined)
}));
vi.mock("@/lib/storage-target", () => ({
    AUTOMATIC_TARGET: "auto",
    LOCAL_TARGET: "local",
    driverForTarget: vi.fn(),
    placeFile,
    resolveStorageTarget: vi.fn(async () => ({ id: NAS, name: "The NAS", automatic: true })),
    safeName: (name: string) => name,
    storageTargetOptions: vi.fn(async () => [])
}));

const { AttachmentStorageError, storeAttachment } = await import("../../src/lib/chat/attachments");

const file = { name: "voice-message.webm", type: "audio/webm;codecs=opus", bytes: new Uint8Array(2048) };

describe("what the row says about where the file is", () => {
    beforeEach(() => {
        placeFile.mockReset();
    });

    it("names the storage the bytes actually reached", async () => {
        placeFile.mockImplementation(async () => ({ targetId: NAS, fellBackFrom: null }));

        const written = await storeAttachment(CHANNEL, file);

        expect(written.connectionId).toBe(NAS);
        expect(written.size).toBe(file.bytes.length);
        // Under the conversation, so a NAS shared with everything else stays
        // legible from a file browser.
        expect(written.path.startsWith(`polaris/chat/${CHANNEL}/`)).toBe(true);
    });

    it("says this server as null, not as a connection that never saw it", async () => {
        // The fallback landed it here. Null is what the download follows; the
        // NAS id would send it looking on a disk the bytes never reached.
        placeFile.mockImplementation(async () => ({ targetId: "local", fellBackFrom: "The NAS" }));

        expect((await storeAttachment(CHANNEL, file)).connectionId).toBeNull();
    });

    it("hands the storage the whole file, once", async () => {
        placeFile.mockImplementation(async () => ({ targetId: "local", fellBackFrom: null }));

        await storeAttachment(CHANNEL, file);

        expect(placeFile).toHaveBeenCalledTimes(1);
        const asked = placeFile.mock.calls[0]![0] as { bytes: Uint8Array; mime: string };
        expect(asked.bytes).toHaveLength(file.bytes.length);
        expect(asked.mime).toBe("audio/webm;codecs=opus");
    });

    it("passes the storage's own words on rather than 'that could not be sent'", async () => {
        placeFile.mockImplementation(async () => {
            throw new Error("The NAS could not take the file (STATUS_DISK_FULL), and neither could this server.");
        });

        const failure = await storeAttachment(CHANNEL, file).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AttachmentStorageError);
        expect((failure as Error).message).toContain("The NAS");
        expect((failure as Error).message).toContain("STATUS_DISK_FULL");
    });

    it("keeps what the browser measured about a recording", async () => {
        placeFile.mockImplementation(async () => ({ targetId: "local", fellBackFrom: null }));

        const written = await storeAttachment(CHANNEL, file, {
            durationMs: 4200,
            waveform: "01234567"
        });

        expect(written.durationMs).toBe(4200);
        expect(written.waveform).toBe("01234567");
    });
});

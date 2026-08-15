/**
 * A conversation does not stop working because a disk did.
 *
 * The failure these are about took an afternoon to find and reached the person
 * using Polaris as "That could not be sent": the NAS uploads are pointed at had
 * gone away, and every path here let that throw escape - so a voice message
 * somebody had just recorded was lost because a share in another room was
 * unplugged. Nobody recording a voice note knows a NAS exists.
 *
 * So the rule is that the bytes end up on something. The chosen storage first,
 * and the disk Polaris itself runs on when that one will not take them - which
 * is always reachable, because Polaris is running. What matters afterwards is
 * that the row says where they really went, because that is what the download
 * follows; a file written here and looked for there is the same broken player
 * with an extra step.
 *
 * The other half is proving the write. A storage that takes a file and refuses
 * to give it back stats perfectly, and every one of these tests would pass on a
 * write that returned without complaining - so the file is opened once, while
 * there is still another storage to try.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NAS = "018f2b7a-0000-7000-8000-0000000000f1";
const CHANNEL = "018f2b7a-0000-7000-8000-0000000000c1";

const openForWriting = vi.fn();

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
    openForWriting,
    resolveStorageTarget: vi.fn(async () => ({ id: NAS, name: "The NAS", automatic: true })),
    safeName: (name: string) => name,
    storageTargetOptions: vi.fn(async () => [])
}));

const { AttachmentStorageError, storeAttachment } = await import("../../src/lib/chat/attachments");

/** A storage that behaves however one test needs it to, and remembers what it
 *  was given so the test can ask where the file actually ended up. */
function storage(behaviour: {
    /** Throws on write, the way a share that is full or read-only does. */
    refuses?: boolean;
    /** Reports fewer bytes than it was handed. */
    keepsOnly?: number;
    /** Takes the file and will not open it again - the one a stat cannot catch. */
    withholds?: boolean;
} = {}) {
    const kept: Uint8Array[] = [];
    return {
        kept,
        mkdir: vi.fn(async () => undefined),
        writeStream: vi.fn(async (_path: string, body: ReadableStream<Uint8Array>) => {
            if (behaviour.refuses) throw new Error("STATUS_DISK_FULL");
            const bytes = new Uint8Array(await new Response(body).arrayBuffer());
            kept.push(bytes);
            return { size: BigInt(behaviour.keepsOnly ?? bytes.length) };
        }),
        readStream: vi.fn(async () => {
            if (behaviour.withholds) throw new Error("STATUS_SHARING_VIOLATION");
            const bytes = kept.at(-1) ?? new Uint8Array();
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                }
            });
        }),
        delete: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined)
    };
}

type Storage = ReturnType<typeof storage>;

/** The chosen storage first, then this server - the order `storeAttachment`
 *  asks in. */
function opens(chosen: Storage, local: Storage): void {
    openForWriting
        .mockImplementationOnce(async () => ({
            driver: chosen,
            targetId: NAS,
            name: "The NAS",
            fellBackFrom: null
        }))
        .mockImplementationOnce(async () => ({
            driver: local,
            targetId: "local",
            name: "this server",
            fellBackFrom: null
        }));
}

const file = { name: "voice-message.webm", type: "audio/webm;codecs=opus", bytes: bytesOf(2048) };

function bytesOf(length: number): Uint8Array {
    return new Uint8Array(length).fill(7);
}

describe("where an attachment ends up", () => {
    beforeEach(() => {
        // Reset rather than clear: a queue left by `mockImplementationOnce`
        // survives `clearAllMocks`, and one test would open the storage the
        // previous one had set up.
        openForWriting.mockReset();
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("stays on the chosen storage when that storage works", async () => {
        const nas = storage();
        const local = storage();
        opens(nas, local);

        const written = await storeAttachment(CHANNEL, file);

        expect(written.connectionId).toBe(NAS);
        expect(nas.kept).toHaveLength(1);
        expect(local.kept).toHaveLength(0);
        expect(written.size).toBe(file.bytes.length);
    });

    it("falls through to this server when the storage refuses the file", async () => {
        const nas = storage({ refuses: true });
        const local = storage();
        opens(nas, local);

        const written = await storeAttachment(CHANNEL, file);

        // Null, not the NAS: the download reads this row, and pointing it at a
        // disk the bytes never reached is the broken player all over again.
        expect(written.connectionId).toBeNull();
        expect(local.kept).toHaveLength(1);
        expect(local.kept[0]).toHaveLength(file.bytes.length);
    });

    it("falls through when the storage keeps only part of the file", async () => {
        const nas = storage({ keepsOnly: 12 });
        const local = storage();
        opens(nas, local);

        const written = await storeAttachment(CHANNEL, file);

        expect(written.connectionId).toBeNull();
        // And the half-written one is taken back off: the message it belonged to
        // is not going to exist, and an orphan is somebody's disk filling up.
        expect(nas.delete).toHaveBeenCalledTimes(1);
    });

    it("falls through when the storage takes the file and will not give it back", async () => {
        // The one a size check cannot catch, and the one that actually happened:
        // written, stat'd, correct, and every read refused.
        const nas = storage({ withholds: true });
        const local = storage();
        opens(nas, local);

        const written = await storeAttachment(CHANNEL, file);

        expect(written.connectionId).toBeNull();
        expect(nas.delete).toHaveBeenCalledTimes(1);
        expect(local.kept).toHaveLength(1);
    });

    it("says which storage failed and how when nothing will take it", async () => {
        const nas = storage({ refuses: true });
        const local = storage({ refuses: true });
        opens(nas, local);

        const failure = await storeAttachment(CHANNEL, file).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AttachmentStorageError);
        // Named, both of them. "That could not be sent" sends whoever reads it
        // looking at the browser, at the network and at the message - anywhere
        // but at the disk that refused it.
        expect((failure as Error).message).toContain("The NAS");
        expect((failure as Error).message).toContain("this server");
        expect((failure as Error).message).toContain("STATUS_DISK_FULL");
    });

    it("keeps what the browser measured about a recording", async () => {
        const nas = storage();
        opens(nas, storage());

        const written = await storeAttachment(CHANNEL, file, {
            durationMs: 4200,
            waveform: "01234567"
        });

        expect(written.durationMs).toBe(4200);
        expect(written.waveform).toBe("01234567");
    });
});

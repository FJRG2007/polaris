/**
 * Getting a file onto a disk that will give it back.
 *
 * One unplugged NAS became a voice message that could not be sent, a profile
 * photo that would not save and a task attachment that failed to upload - three
 * screens, three bug reports, one cable. Every upload path let the same throw
 * escape, and the two that had been taught not to had been taught separately, so
 * a recording survived what a photo did not.
 *
 * So it is one function now, and these are the four ways a storage says no. Only
 * the first is what "the write failed" usually means:
 *
 * - it will not open at all (the box is off).
 * - it refuses the write.
 * - it keeps part of the file.
 * - it takes the file and will not give it back - which stats perfectly, and is
 *   the one that actually happened.
 *
 * In all four the bytes end up on the disk Polaris runs on, and what comes back
 * says so: the caller records where the file went, and a file on this server
 * with a row that says NAS is the same broken download with an extra step.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NAS = "018f2b7a-0000-7000-8000-0000000000f1";

const getDriverForConnection = vi.fn();

/** A storage that behaves however a test needs it to, and remembers what it was
 *  given so the test can ask where the file actually ended up. */
function storage(
    behaviour: {
        /** Throws on write, the way a share that is full or read-only does. */
        refuses?: boolean;
        /** Reports fewer bytes than it was handed. */
        keepsOnly?: number;
        /** Takes the file and will not open it again - the one a stat cannot
         *  catch, and the one that cost an afternoon. */
        withholds?: boolean;
    } = {}
) {
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

/** Whether the disk Polaris runs on is itself unusable, for the one case where
 *  there is nowhere left to fall. */
let broken = false;
/** What this server does with a file, so a fallback can be watched arriving. */
let here = storage();

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => undefined) }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: "/var/polaris" }) }));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(async () => undefined)
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        storageConnection: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) }
    }
}));
vi.mock("@polaris/storage", () => ({
    // The disk Polaris runs on, which every fallback lands on. It has to behave
    // like a storage rather than merely open: what is being tested is what
    // happens after the open.
    LocalDriver: class {
        public readonly id: string;
        public constructor(options: { id: string; root: string }) {
            this.id = options.id;
        }
        public async connect(): Promise<void> {
            if (broken) throw new Error("EACCES: the data directory is not writable");
        }
        public mkdir(path: string) {
            return here.mkdir(path);
        }
        public writeStream(path: string, body: ReadableStream<Uint8Array>) {
            return here.writeStream(path, body);
        }
        public readStream() {
            return here.readStream();
        }
        public delete() {
            return here.delete();
        }
        public dispose() {
            return here.dispose();
        }
    }
}));

const { LOCAL_TARGET, forgetStorageFailure, openForWriting, placeFile } = await import(
    "../../src/lib/storage-target"
);

const nas = { id: NAS, name: "The NAS", automatic: true };
const bytes = new Uint8Array(2048).fill(7);

const put = () =>
    placeFile({
        target: nas,
        localFolder: "chat",
        folder: "polaris/chat/c1",
        path: "polaris/chat/c1/file",
        bytes,
        mime: "audio/webm",
        what: "file"
    });

beforeEach(() => {
    broken = false;
    here = storage();
    // What one test taught the module about this storage is not something the
    // next one should still be paying for.
    forgetStorageFailure(NAS);
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("opening a storage to write to", () => {
    it("uses the chosen storage when it answers", async () => {
        const driver = { id: NAS };
        getDriverForConnection.mockImplementation(async () => driver);

        const opened = await openForWriting(nas, "chat");

        expect(opened.targetId).toBe(NAS);
        expect(opened.fellBackFrom).toBeNull();
        expect(opened.driver).toBe(driver);
    });

    it("uses this server when the chosen storage cannot be reached", async () => {
        getDriverForConnection.mockImplementation(async () => {
            throw new Error("SMB connection failed: ECONNREFUSED");
        });

        const opened = await openForWriting(nas, "chat");

        // The two facts the caller needs: the bytes are going somewhere, and it
        // is not where the setting says.
        expect(opened.targetId).toBe(LOCAL_TARGET);
        expect(opened.fellBackFrom).toBe("The NAS");
    });

    it("says so, because there is a share to go and fix", async () => {
        const complained = vi.spyOn(console, "error").mockImplementation(() => undefined);
        getDriverForConnection.mockImplementation(async () => {
            throw new Error("SMB connection failed: ECONNREFUSED");
        });

        await openForWriting(nas, "chat");

        expect(complained).toHaveBeenCalled();
    });

    it("stops trying a storage that just refused, for a while", async () => {
        getDriverForConnection.mockImplementation(async () => {
            throw new Error("SMB connection failed: ETIMEDOUT");
        });

        await openForWriting(nas, "chat");
        const again = await openForWriting(nas, "chat");

        // The second upload does not pay the timeout again. That wait is what
        // turns an unplugged share into a chat where everything anybody sends
        // takes ten seconds to arrive.
        expect(again.targetId).toBe(LOCAL_TARGET);
        expect(getDriverForConnection).toHaveBeenCalledTimes(1);
    });

    it("goes back to it once it has proved itself", async () => {
        getDriverForConnection.mockImplementation(async () => {
            throw new Error("SMB connection failed: ETIMEDOUT");
        });
        await openForWriting(nas, "chat");

        // What the check on the uploads screen does when it passes.
        forgetStorageFailure(NAS);
        const driver = { id: NAS };
        getDriverForConnection.mockImplementation(async () => driver);

        expect((await openForWriting(nas, "chat")).targetId).toBe(NAS);
    });

    it("throws when this server is the one that cannot be opened", async () => {
        // Nowhere left to fall. Refusing here is honest; the alternative is
        // pretending a file was stored.
        broken = true;

        const local = { id: LOCAL_TARGET, name: "This server", automatic: false };
        await expect(openForWriting(local, "chat")).rejects.toThrow(/EACCES/);
    });
});

describe("placing a file", () => {
    it("stays on the chosen storage when that storage works", async () => {
        const box = storage();
        getDriverForConnection.mockImplementation(async () => box);

        const placed = await put();

        expect(placed.targetId).toBe(NAS);
        expect(placed.fellBackFrom).toBeNull();
        expect(box.kept).toHaveLength(1);
        expect(box.kept[0]).toHaveLength(bytes.length);
        expect(here.kept).toHaveLength(0);
    });

    it("falls through to this server when the storage refuses the file", async () => {
        // Reached, and still would not keep it. Nobody recording a voice note
        // knows a NAS exists.
        getDriverForConnection.mockImplementation(async () => storage({ refuses: true }));

        const placed = await put();

        expect(placed.targetId).toBe(LOCAL_TARGET);
        expect(placed.fellBackFrom).toBe("The NAS");
        expect(here.kept).toHaveLength(1);
    });

    it("falls through when the storage keeps only part of the file", async () => {
        const box = storage({ keepsOnly: 12 });
        getDriverForConnection.mockImplementation(async () => box);

        expect((await put()).targetId).toBe(LOCAL_TARGET);
        // And the half-written one is taken back off: an orphan is somebody's
        // disk quietly filling up.
        expect(box.delete).toHaveBeenCalled();
    });

    it("falls through when the storage takes the file and will not give it back", async () => {
        // The one a size check cannot catch, and the one that actually happened:
        // written, stat'd, correct, and every read refused.
        const box = storage({ withholds: true });
        getDriverForConnection.mockImplementation(async () => box);

        expect((await put()).targetId).toBe(LOCAL_TARGET);
        expect(box.delete).toHaveBeenCalled();
        expect(here.kept).toHaveLength(1);
    });

    it("falls through when the storage cannot be opened at all", async () => {
        getDriverForConnection.mockImplementation(async () => {
            throw new Error("SMB connection failed: ECONNREFUSED");
        });

        expect((await put()).targetId).toBe(LOCAL_TARGET);
    });

    it("says which storage failed and how when nothing will take it", async () => {
        getDriverForConnection.mockImplementation(async () => storage({ refuses: true }));
        // This server refusing too, which is the only case worth failing on.
        broken = true;

        const failure = await put().catch((error: unknown) => error);

        // Both of them named. "That could not be saved" sends whoever reads it
        // looking at the browser, at the network and at the file - anywhere but
        // at the disk that refused it.
        expect((failure as Error).message).toContain("The NAS");
        expect((failure as Error).message).toContain("STATUS_DISK_FULL");
        expect((failure as Error).message).toContain("this server");
    });
});

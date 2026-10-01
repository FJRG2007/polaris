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
/** The administrators being told, which is what an unplugged NAS now does. */
const reportStorageUnreachable = vi.fn(async () => undefined);
const storageAnswered = vi.fn();

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
vi.mock("@/lib/storage-alert", () => ({ reportStorageUnreachable, storageAnswered }));
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

const {
    LOCAL_TARGET,
    StorageRefused,
    forgetStorageFailure,
    isUnreachable,
    openForWriting,
    placeFile,
    streamFile
} = await import("../../src/lib/storage-target");
const { storageRefusal } = await import("../../src/lib/storage-refusal");

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

/** A request body, the way a route hands one to `streamFile`. */
function body(size = 512): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(size).fill(3));
            controller.close();
        }
    });
}

const stream = () =>
    streamFile({
        target: nas,
        localFolder: "chat",
        folder: "polaris/chat/c1",
        path: "polaris/chat/c1/upload",
        body: body(),
        mime: "image/png",
        what: "file"
    });

/** Lets the module's own awaits run between two jumps of the fake clock. */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("a storage that is switched off", () => {
    it("is given up on after a bounded wait, and the file goes to this server", async () => {
        // The live case: the host daemon's mount of a NAS that is off, and the
        // userspace connect after it, never came back - so the upload never did.
        vi.useFakeTimers();
        try {
            getDriverForConnection.mockImplementation(() => new Promise(() => undefined));
            let opened: Awaited<ReturnType<typeof openForWriting>> | null = null;
            void openForWriting(nas, "chat").then((result) => {
                opened = result;
            });
            await vi.advanceTimersByTimeAsync(19_000);
            expect(opened).toBeNull();
            await vi.advanceTimersByTimeAsync(1_500);
            expect(opened).not.toBeNull();
            expect(opened!.targetId).toBe(LOCAL_TARGET);
            expect(opened!.fellBackFrom).toBe("The NAS");
        } finally {
            vi.useRealTimers();
        }
    });

    it("tells the administrators, by the storage's name", async () => {
        getDriverForConnection.mockImplementation(async () => {
            throw new Error("SMB connection failed: connect EHOSTUNREACH 192.0.2.10:445");
        });

        await openForWriting(nas, "chat");

        await vi.waitFor(() =>
            expect(reportStorageUnreachable).toHaveBeenCalledWith({ id: NAS, name: "The NAS" })
        );
    });

    it("says it answered again once it does, so the next outage is news", async () => {
        getDriverForConnection.mockImplementationOnce(async () => {
            throw new Error("SMB connection failed: EHOSTUNREACH");
        });
        await openForWriting(nas, "chat");
        getDriverForConnection.mockImplementation(async () => ({ id: NAS }));
        // Past the minute it is skipped for.
        const later = Date.now() + 61_000;
        vi.spyOn(Date, "now").mockReturnValue(later);
        const opened = await openForWriting(nas, "chat");
        await settle();
        vi.mocked(Date.now).mockRestore();

        expect(opened.targetId).toBe(NAS);
        await vi.waitFor(() => expect(storageAnswered).toHaveBeenCalledWith(NAS));
    });
});

describe("streaming a file to a storage that stops answering", () => {
    it("lands on this server when the storage cannot be opened, and records that", async () => {
        getDriverForConnection.mockImplementation(async () => {
            throw new Error("SMB connection failed: connect EHOSTUNREACH 192.0.2.10:445");
        });

        const placed = await stream();

        expect(placed.targetId).toBe(LOCAL_TARGET);
        expect(placed.fellBackFrom).toBe("The NAS");
        expect(here.kept).toHaveLength(1);
    });

    it("gives up on a write that goes silent, by the storage's name", async () => {
        // It opened - a session that was alive a minute ago - and then took the
        // bytes and never finished. The request used to wait on it for ever.
        vi.useFakeTimers();
        try {
            const box = storage();
            box.writeStream.mockImplementation(
                async (_path: string, stream: ReadableStream<Uint8Array>) => {
                    await new Response(stream).arrayBuffer();
                    return new Promise<{ size: bigint }>(() => undefined);
                }
            );
            getDriverForConnection.mockImplementation(async () => box);

            let failure: unknown = null;
            void stream().catch((error: unknown) => {
                failure = error;
            });
            await vi.advanceTimersByTimeAsync(59_000);
            expect(failure).toBeNull();
            await vi.advanceTimersByTimeAsync(7_000);

            expect(failure).toBeInstanceOf(StorageRefused);
            expect((failure as InstanceType<typeof StorageRefused>).storage).toBe("The NAS");
            expect((failure as InstanceType<typeof StorageRefused>).unreachable).toBe(true);
            // Nothing half-written is left under a name that reads like a whole file.
            expect(box.delete).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("names the storage when the network drops under the write", async () => {
        const box = storage();
        box.writeStream.mockImplementation(async () => {
            throw Object.assign(new Error("write EHOSTUNREACH"), { code: "EHOSTUNREACH" });
        });
        getDriverForConnection.mockImplementation(async () => box);

        const failure = await stream().catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(StorageRefused);
        expect(isUnreachable(failure)).toBe(true);
        expect((failure as InstanceType<typeof StorageRefused>).storage).toBe("The NAS");
    });

    it("remembers a storage that went away mid-write, so trying again lands on this server", async () => {
        const box = storage();
        box.writeStream.mockImplementation(async () => {
            throw Object.assign(new Error("write EHOSTDOWN"), { code: "EHOSTDOWN" });
        });
        getDriverForConnection.mockImplementation(async () => box);

        await stream().catch(() => undefined);
        await vi.waitFor(() =>
            expect(reportStorageUnreachable).toHaveBeenCalledWith({ id: NAS, name: "The NAS" })
        );
        getDriverForConnection.mockClear();
        const again = await stream();

        expect(getDriverForConnection).not.toHaveBeenCalled();
        expect(again.targetId).toBe(LOCAL_TARGET);
        expect(again.fellBackFrom).toBe("The NAS");
    });

    it("does not count a storage that answered and refused as gone", async () => {
        getDriverForConnection.mockImplementation(async () => storage({ refuses: true }));

        await stream().catch(() => undefined);
        getDriverForConnection.mockClear();
        await stream().catch(() => undefined);

        expect(getDriverForConnection).toHaveBeenCalled();
        expect(reportStorageUnreachable).not.toHaveBeenCalled();
    });
});

describe("a file when this server will not open either", () => {
    it("is refused as a storage refusal, not as the disk's own error", async () => {
        broken = true;
        const local = { id: LOCAL_TARGET, name: "This server", automatic: false };

        const failure = await placeFile({
            target: local,
            localFolder: "chat",
            folder: "polaris/chat/c1",
            path: "polaris/chat/c1/file",
            bytes,
            mime: "audio/webm",
            what: "file"
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(StorageRefused);
        expect(await storageRefusal(failure, false)).toBe("No storage would keep that file.");
    });
});

describe("placing a file on a storage that goes away mid-write", () => {
    it("is remembered, so the next file skips it", async () => {
        const box = storage();
        box.writeStream.mockImplementation(async () => {
            throw Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" });
        });
        getDriverForConnection.mockImplementation(async () => box);

        const first = await put();
        getDriverForConnection.mockClear();
        const second = await put();

        expect(first.targetId).toBe(LOCAL_TARGET);
        expect(second.targetId).toBe(LOCAL_TARGET);
        expect(getDriverForConnection).not.toHaveBeenCalled();
        await vi.waitFor(() =>
            expect(reportStorageUnreachable).toHaveBeenCalledWith({ id: NAS, name: "The NAS" })
        );
    });
});

describe("what the sender is told", () => {
    it("is that files cannot be saved, and which storage is not there", async () => {
        const failure = new StorageRefused(
            "The NAS could not take the file: EHOSTUNREACH",
            "UNAS Pro",
            true
        );

        expect(await storageRefusal(failure, false)).toBe(
            "Files cannot be saved right now: the storage UNAS Pro is not reachable."
        );
    });

    it("keeps the device's own words for an administrator", async () => {
        const failure = new StorageRefused(
            "UNAS Pro could not take the file: EHOSTUNREACH",
            "UNAS Pro",
            true
        );

        const said = await storageRefusal(failure, true);
        expect(said).toContain("the storage UNAS Pro is not reachable");
        expect(said).toContain("EHOSTUNREACH");
    });

    it("tells a refusal from an outage", async () => {
        const failure = new StorageRefused(
            "UNAS Pro could not take the file: STATUS_DISK_FULL",
            "UNAS Pro"
        );

        expect(await storageRefusal(failure, false)).toBe(
            "The storage UNAS Pro would not keep that file."
        );
    });

    it("does not blame a storage for a failure that is not one", async () => {
        const failure = new Error("Unique constraint failed on the fields: (`id`)");

        expect(await storageRefusal(failure, false)).toBe(
            "That file could not be saved. Try again."
        );
    });
});

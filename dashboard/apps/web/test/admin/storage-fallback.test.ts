/**
 * Opening a storage is itself a thing that fails.
 *
 * Reaching a connection is a TCP connect, a login and a tree connect against a
 * box somebody may have unplugged, and it throws when that box is not there.
 * Every upload in Polaris used to let that throw escape - which is how one
 * unplugged NAS became a voice message that could not be sent, a profile photo
 * that would not save and a task attachment that failed to upload: three
 * screens, three bug reports, one cable.
 *
 * None of them is worth losing what somebody just made, so the disk Polaris runs
 * on takes it instead. The part that has to be right is what comes back: the
 * caller records `targetId`, and a file that went to this server while the row
 * says NAS is the same broken download with an extra step.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NAS = "018f2b7a-0000-7000-8000-0000000000f1";

const getDriverForConnection = vi.fn();

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
    LocalDriver: class {
        public readonly id: string;
        public readonly root: string;
        public constructor(options: { id: string; root: string }) {
            this.id = options.id;
            this.root = options.root;
        }
        public async connect(): Promise<void> {
            if (broken) throw new Error("EACCES: the data directory is not writable");
        }
    }
}));

/** Whether the disk Polaris runs on is itself unusable, for the one case where
 *  there is nowhere left to fall. */
let broken = false;

const { LOCAL_TARGET, forgetStorageFailure, openForWriting } = await import(
    "../../src/lib/storage-target"
);

const nas = { id: NAS, name: "The NAS", automatic: true };

describe("opening a storage to write to", () => {
    beforeEach(() => {
        broken = false;
        // What one test taught the module about this storage is not something
        // the next one should still be paying for.
        forgetStorageFailure(NAS);
        vi.clearAllMocks();
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

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

        const here = { id: LOCAL_TARGET, name: "This server", automatic: false };
        await expect(openForWriting(here, "chat")).rejects.toThrow(/EACCES/);
    });
});

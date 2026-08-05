import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropListings, prefetchListing, readListing, writeListing } from "@/app/(app)/drive/listing-cache";

/** sessionStorage as the cache expects it; jsdom is not loaded for these tests. */
class MemoryStorage {
    private readonly items = new Map<string, string>();
    public get length(): number {
        return this.items.size;
    }
    public key(index: number): string | null {
        return [...this.items.keys()][index] ?? null;
    }
    public getItem(key: string): string | null {
        return this.items.get(key) ?? null;
    }
    public setItem(key: string, value: string): void {
        this.items.set(key, value);
    }
    public removeItem(key: string): void {
        this.items.delete(key);
    }
    public clear(): void {
        this.items.clear();
    }
}

const entry = (name: string) => ({
    name,
    path: name,
    kind: "dir" as const,
    size: "0",
    modifiedAt: "2026-08-05T00:00:00.000Z",
    createdAt: "2026-08-05T00:00:00.000Z",
    hidden: false,
    favorite: false,
    icon: null,
    iconColor: null,
    note: null,
    owner: null,
    locked: false
});

describe("Drive listing cache", () => {
    beforeEach(() => {
        vi.stubGlobal("sessionStorage", new MemoryStorage());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("hands back a listing it was given, per connection and path", () => {
        writeListing("host:a", "docs", [entry("one")]);
        expect(readListing("host:a", "docs")?.map((item) => item.name)).toEqual(["one"]);
        // A different folder, or a different source, is a different listing.
        expect(readListing("host:a", "")).toBeNull();
        expect(readListing("host:b", "docs")).toBeNull();
    });

    it("forgets everything after a write, wherever the write landed", () => {
        writeListing("host:a", "", [entry("one")]);
        writeListing("host:b", "docs", [entry("two")]);
        dropListings();
        expect(readListing("host:a", "")).toBeNull();
        expect(readListing("host:b", "docs")).toBeNull();
    });

    it("stops reading a listing once it is too old to trust", () => {
        writeListing("host:a", "", [entry("one")]);
        // Past the 30s window the cache is a guess about somebody else's filesystem.
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
        expect(readListing("host:a", "")).toBeNull();
    });

    it("prefetches a folder once and caches what comes back", async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ entries: [entry("one")] }) }));
        vi.stubGlobal("fetch", fetchMock);

        prefetchListing("host:a", "docs");
        // A cursor crossing the same row again must not ask again.
        prefetchListing("host:a", "docs");
        await vi.waitFor(() => expect(readListing("host:a", "docs")).not.toBeNull());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]![0]).toBe("/api/drive/list?c=host%3Aa&p=docs");
        // Already cached: nothing more to fetch.
        prefetchListing("host:a", "docs");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("caches nothing when a prefetch is refused", async () => {
        const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({ error: "Forbidden" }) }));
        vi.stubGlobal("fetch", fetchMock);
        prefetchListing("host:a", "secret");
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(readListing("host:a", "secret")).toBeNull();
    });
});

// The pool is tested in @polaris/ssh; what belongs here is the app's own reuse of
// the SFTP channel on top of it, since a channel handed out after its connection
// died would fail every later listing.
describe("borrowed SFTP channels", () => {
    it("opens one channel per connection and reopens after it ends", async () => {
        const sftp = new EventEmitter();
        const client = Object.assign(new EventEmitter(), {
            sftp: vi.fn((callback: (error: Error | undefined, channel: unknown) => void) => callback(undefined, sftp)),
            end: vi.fn()
        });
        vi.doMock("@polaris/ssh", async (importOriginal) => {
            const actual = await importOriginal<typeof import("@polaris/ssh")>();
            return { ...actual, openSshClient: vi.fn(async () => client) };
        });
        const { borrowSftp } = await import("@/lib/ssh-pool");
        const options = { host: "h", port: 22, username: "u", auth: { method: "password" as const, password: "p" } };

        const first = await borrowSftp("drive", "host-a", options);
        first.release();
        const second = await borrowSftp("drive", "host-a", options);
        second.release();
        expect(first.sftp).toBe(second.sftp);
        expect(client.sftp).toHaveBeenCalledTimes(1);

        // The far end closed the channel: the next borrower gets a new one.
        sftp.emit("end");
        const third = await borrowSftp("drive", "host-a", options);
        third.release();
        expect(client.sftp).toHaveBeenCalledTimes(2);
        vi.doUnmock("@polaris/ssh");
    });
});

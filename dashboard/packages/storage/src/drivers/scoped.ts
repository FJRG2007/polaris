/**
 * A driver that confines another driver to one folder.
 *
 * Every backend Polaris talks to is already rooted somewhere - a share, a
 * bucket, an SSH login's filesystem - and a personal drive is a folder inside
 * whichever of those the instance writes to. Rather than teaching each driver a
 * second root, the path is translated on the way in and back out here, so what
 * the caller sees is a storage whose root is that folder and which cannot name
 * anything above it.
 *
 * The confinement is not this class's own invention: `normalizeRelPath` resolves
 * `..` and refuses to climb past the start of a relative path, so a path that
 * escapes the prefix cannot be built in the first place. What this adds is that
 * the prefix is never visible - a listing under it comes back with paths the
 * caller can hand straight back, which is what everything upstream (metadata
 * rows, shares, breadcrumbs) already assumes about a driver's paths.
 */

import { normalizeRelPath } from "@polaris/core";
import type { StorageProviderKind } from "@polaris/core";
import {
    StorageError,
    type ListOptions,
    type ListResult,
    type ReadRange,
    type StatEntry,
    type StorageDriver,
    type StorageDriverCapabilities,
    type StorageUsage,
    type WriteOptions
} from "../driver.js";

export interface ScopedDriverOptions {
    /** The id this storage answers to, which is the scope's, not the inner one's. */
    readonly id: string;
    /** The driver being confined. Disposed of with this one. */
    readonly inner: StorageDriver;
    /** The folder, relative to the inner driver's own root. */
    readonly prefix: string;
    /** Make the folder on connect. On for a drive Polaris owns and provisions;
     *  off when the folder is somebody else's and its absence is an error worth
     *  hearing rather than papering over. */
    readonly createRoot?: boolean;
}

export class ScopedDriver implements StorageDriver {
    public readonly id: string;
    private readonly inner: StorageDriver;
    private readonly prefix: string;
    private readonly createRoot: boolean;

    public constructor(options: ScopedDriverOptions) {
        this.id = options.id;
        this.inner = options.inner;
        this.prefix = normalizeRelPath(options.prefix);
        this.createRoot = options.createRoot ?? false;
    }

    /** The backend underneath, so callers that branch on it keep working. */
    public get kind(): StorageProviderKind {
        return this.inner.kind;
    }

    public get capabilities(): StorageDriverCapabilities {
        return this.inner.capabilities;
    }

    /** A caller's path, as the inner driver would name it. */
    private within(path: string): string {
        const rel = normalizeRelPath(path);
        if (this.prefix === "") return rel;
        return rel === "" ? this.prefix : `${this.prefix}/${rel}`;
    }

    /** An inner path, as the caller named it. */
    private outside(path: string): string {
        const rel = normalizeRelPath(path);
        if (this.prefix === "") return rel;
        if (rel === this.prefix) return "";
        if (rel.startsWith(`${this.prefix}/`)) return rel.slice(this.prefix.length + 1);
        // The backend answered about something outside the scope. Nothing above
        // can do anything with that path, and passing it on would put a location
        // the caller may not reach into a listing, so it is a fault here.
        throw new StorageError("io_error", `Storage answered outside its folder: ${path}`);
    }

    private entry(stat: StatEntry): StatEntry {
        return { ...stat, path: this.outside(stat.path) };
    }

    public async connect(): Promise<void> {
        await this.inner.connect();
        if (this.createRoot && this.prefix !== "") {
            // mkdir is create-if-absent on every driver, so this is the whole of
            // "make sure the folder is there" and costs one call on a drive that
            // already has it.
            await this.inner.mkdir(this.prefix);
        }
    }

    public async dispose(): Promise<void> {
        await this.inner.dispose();
    }

    public async list(path: string, options?: ListOptions): Promise<ListResult> {
        const result = await this.inner.list(this.within(path), options);
        return {
            entries: result.entries.map((entry) => this.entry(entry)),
            nextCursor: result.nextCursor
        };
    }

    public async stat(path: string): Promise<StatEntry> {
        return this.entry(await this.inner.stat(this.within(path)));
    }

    // These are `async` rather than plain pass-throughs on purpose: translating
    // the path can refuse it (a path that climbs out of the folder), and a
    // Promise-returning method that throws where it is CALLED rather than
    // rejecting is a trap for every caller that only wrote a `.catch`.
    public async readStream(path: string, range?: ReadRange): Promise<ReadableStream<Uint8Array>> {
        return this.inner.readStream(this.within(path), range);
    }

    public async writeStream(
        path: string,
        body: ReadableStream<Uint8Array>,
        options?: WriteOptions
    ): Promise<StatEntry> {
        return this.entry(await this.inner.writeStream(this.within(path), body, options));
    }

    public async mkdir(path: string): Promise<void> {
        await this.inner.mkdir(this.within(path));
    }

    public async move(from: string, to: string): Promise<void> {
        await this.inner.move(this.within(from), this.within(to));
    }

    public async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
        // The scope's own root is not something a caller may remove: it is the
        // drive itself, and the backend would happily take the whole folder.
        if (normalizeRelPath(path) === "" && this.prefix !== "") {
            throw new StorageError("permission_denied", "This folder cannot be removed");
        }
        await this.inner.delete(this.within(path), options);
    }

    public async usage(): Promise<StorageUsage> {
        // Whatever the disk underneath reports. A per-person allowance would be
        // a Polaris rule rather than a property of the storage, so nothing is
        // smuggled in here as free space.
        return this.inner.usage();
    }
}

/**
 * What every kind of protected thing has to be able to do, and the staging that
 * makes replication cheap.
 *
 * A source produces an artifact once. The engine then writes it to as many
 * destinations as the plan lists, which is why `produce` writes to a local file
 * rather than returning a stream: a stream can be consumed once, and reading a
 * 40 GB world four times to put it in four places would cost four archives of a
 * live server rather than one.
 *
 * Staging also answers a constraint that would otherwise be invisible until it
 * failed: OneDrive refuses a large upload without a total size up front, and a
 * file on disk always has one.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceKind } from "../kinds";
import { mkdtemp, rm, stat } from "node:fs/promises";

/** The row a source is asked to act on. */
export interface SourceResource {
    readonly id: string;
    readonly ownerId: string;
    readonly kind: ResourceKind;
    readonly selector: string;
    readonly name: string;
    /** Kind-specific settings, already parsed from the stored JSON. */
    readonly config: Record<string, unknown>;
}

/** An artifact staged on local disk, ready to be copied anywhere. */
export interface StagedArtifact {
    /** Absolute path of the staged file. */
    readonly path: string;
    /** What to call the copy in a destination. */
    readonly fileName: string;
    readonly sizeBytes: number;
    /** What the source knew at the time, kept for the restore that needs it. */
    readonly metadata: Record<string, unknown>;
    /** Remove the staged file. Always called, including when a copy failed. */
    cleanup(): Promise<void>;
}

/**
 * A copy that lives inside the source rather than in a destination.
 *
 * Only a game server has these: its container can archive its own disk in
 * seconds, which is worth keeping as the fast copy even though it dies with the
 * disk it protects.
 */
export interface InPlaceCopy {
    readonly path: string;
    readonly sizeBytes: number;
    readonly takenAt: Date;
}

/** Something that can be backed up. */
export interface BackupSource {
    readonly kind: ResourceKind;

    /**
     * Things of this kind that exist and could be protected.
     *
     * Used by "protect something" to offer what is here rather than asking
     * somebody to type an id. Kinds nobody can enumerate return nothing.
     */
    discover(ownerId: string): Promise<DiscoveredTarget[]>;

    /** The current display name, so a renamed source is not stale in the table. */
    resolveName(resource: SourceResource): Promise<string | null>;

    /** Produce the artifact, staged on local disk. */
    produce(resource: SourceResource): Promise<StagedArtifact>;

    /**
     * Take the copy in place, inside the source, when the kind supports it.
     *
     * Returns null for every kind that does not, which the engine reads as "this
     * plan's beside-the-source destination has nothing to do here" rather than
     * as a failure.
     */
    produceInPlace?(resource: SourceResource): Promise<InPlaceCopy | null>;

    /** Read an in-place copy back out, so it can be replicated or downloaded. */
    readInPlace?(resource: SourceResource, path: string): Promise<ReadableStream<Uint8Array>>;

    /** Remove an in-place copy that has fallen out of retention. */
    removeInPlace?(resource: SourceResource, path: string): Promise<void>;

    /**
     * Put a copy back.
     *
     * Destructive by definition, so the engine only calls it once somebody has
     * confirmed. A kind that cannot do it safely leaves this undefined and the
     * console offers a download instead.
     */
    restore?(
        resource: SourceResource,
        body: ReadableStream<Uint8Array>,
        metadata: Record<string, unknown>,
        /** Who asked for it, for whatever the source records about the change. */
        actorId: string
    ): Promise<void>;
}

/** Something that exists and could be protected. */
export interface DiscoveredTarget {
    readonly kind: ResourceKind;
    /** The identity it would be protected under. */
    readonly selector: string;
    readonly name: string;
    /** What it belongs to, for a list that mixes kinds ("on tonto", "in acme"). */
    readonly context?: string;
    /** The target payload, ready to hand back to `protect`. */
    readonly target: Record<string, unknown>;
}

/** Raised when a source cannot produce right now, with the reason to record. */
export class SourceUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "SourceUnavailableError";
    }
}

/** A private directory for one artifact, removed whatever happens to it. */
export async function stageDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "polaris-backup-"));
}

/** Finish staging: measure what was written and hand back the cleanup. */
export async function stagedFrom(
    dir: string,
    filePath: string,
    fileName: string,
    metadata: Record<string, unknown>
): Promise<StagedArtifact> {
    const info = await stat(filePath);
    return {
        path: filePath,
        fileName,
        sizeBytes: info.size,
        metadata,
        cleanup: async () => {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    };
}

/**
 * Single-quote an argument for an `sh -c` running inside a container.
 *
 * Shared because two sources redirect a dump or an archive through a shell, and
 * a quoting helper that exists twice is one that will be fixed once.
 */
export function shellQuote(value: string): string {
    const escaped = value.split("'").join(`'\\''`);
    return `'${escaped}'`;
}

/** A filesystem-safe timestamp for a copy's name. */
export function stamp(at: Date): string {
    return at.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

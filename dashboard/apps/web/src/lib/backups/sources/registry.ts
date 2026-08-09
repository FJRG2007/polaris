/**
 * Which module handles which kind.
 *
 * One map, so the engine never branches on a kind: it looks the source up and
 * calls the same four methods whatever it found. Adding a kind is a line here
 * plus a module, and nothing in the orchestration changes.
 */

import type { BackupSource } from "./types";
import type { ResourceKind } from "../kinds";
import { minecraftWorldSource } from "./minecraft";
import { deployVolumeSource, nasPathSource } from "./files";
import { managedDatabaseSource, polarisDatabaseSource } from "./databases";

const SOURCES: Readonly<Record<ResourceKind, BackupSource>> = {
    "polaris-database": polarisDatabaseSource,
    "managed-database": managedDatabaseSource,
    "minecraft-world": minecraftWorldSource,
    "deploy-volume": deployVolumeSource,
    "nas-path": nasPathSource
};

/** The source for a kind. Every kind has one - the record is exhaustive. */
export function sourceFor(kind: ResourceKind): BackupSource {
    return SOURCES[kind];
}

/** Every source, for the discovery pass that offers what could be protected. */
export function allSources(): readonly BackupSource[] {
    return Object.values(SOURCES);
}

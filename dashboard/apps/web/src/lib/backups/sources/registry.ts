/**
 * Which module handles which kind.
 *
 * One map, so the engine never branches on a kind: it looks the source up and
 * calls the same four methods whatever it found. Adding a kind is a line here
 * plus a module, and nothing in the orchestration changes.
 */

import type { BackupSource } from "./types";
import type { ResourceKind } from "../kinds";
import { mailServerSource } from "./mail-server";
import { appBackupSource, appBackupSources } from "@/lib/app-extensions/registry";
import { deployVolumeSource, nasPathSource } from "./files";
import { managedDatabaseSource, polarisDatabaseSource } from "./databases";

const SOURCES: Readonly<Partial<Record<ResourceKind, BackupSource>>> = {
    "polaris-database": polarisDatabaseSource,
    "managed-database": managedDatabaseSource,
    "deploy-volume": deployVolumeSource,
    "mail-server": mailServerSource,
    "nas-path": nasPathSource
};

/**
 * What a kind reads as while the app that provides it is not installed.
 *
 * The protected resource and its copies stay, so reinstalling picks them up
 * again; until then nothing is discovered and a copy fails saying why.
 */
function unavailableSource(kind: ResourceKind): BackupSource {
    const reason = "The app this belongs to is not installed, so it cannot be copied until it is.";
    return {
        kind,
        discover: async () => [],
        resolveName: async () => null,
        produce: async () => {
            throw new Error(reason);
        }
    };
}

/** The source for a kind: core's own, or the one an installed app provides. */
export function sourceFor(kind: ResourceKind): BackupSource {
    return SOURCES[kind] ?? appBackupSource(kind) ?? unavailableSource(kind);
}

/** Every source, for the discovery pass that offers what could be protected. */
export function allSources(): readonly BackupSource[] {
    return [...Object.values(SOURCES).filter((source): source is BackupSource => Boolean(source)), ...appBackupSources()];
}

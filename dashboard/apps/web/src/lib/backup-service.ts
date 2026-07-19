/**
 * Backup service. The first target is the Polaris database - a one-click dump the
 * operator can take before a risky change (a migration, an upgrade) and download
 * or keep on the host. A backup is a gzipped logical snapshot: every table read
 * through Prisma and written as JSON, so it needs no external tool (no pg_dump)
 * and works the same on Postgres and the SQLite dev database. Backups are plain
 * files, so the feature needs no schema of its own and can ship before a DB
 * migration. The structure is deliberately target-agnostic (`kind`) so NAS and,
 * later, other-app backups slot in beside the database one.
 *
 * The container runs unprivileged, so the data dir may not be writable; if it is
 * not, backups fall back to a writable temp dir (still downloadable, just not
 * persisted across restarts). Node runtime.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { loadEnv } from "@polaris/config";
import { Prisma, prisma } from "@polaris/db";

export type BackupKind = "database";

export interface BackupInfo {
    name: string;
    kind: BackupKind;
    sizeBytes: number;
    createdAt: string;
    /** True when backups are in a temp dir (data dir not writable) and won't persist. */
    ephemeral: boolean;
}

/** Cached resolution of the writable backup directory for this process. */
let resolved: { dir: string; ephemeral: boolean } | null = null;

/**
 * Resolve a writable backup directory: the configured data dir if we can write to
 * it, otherwise a temp dir. Cached so repeated calls do not re-probe the fs.
 */
async function ensureBackupDir(): Promise<{ dir: string; ephemeral: boolean }> {
    if (resolved) return resolved;
    const primary = join(loadEnv().POLARIS_DATA_DIR, "backups");
    try {
        await mkdir(primary, { recursive: true });
        resolved = { dir: primary, ephemeral: false };
        return resolved;
    } catch {
        const fallback = join(tmpdir(), "polaris-backups");
        await mkdir(fallback, { recursive: true });
        resolved = { dir: fallback, ephemeral: true };
        return resolved;
    }
}

/** Reject a caller-supplied backup name that tries to escape the backup dir. */
function safeName(name: string): string {
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new Error("Invalid backup name");
    }
    return name;
}

/** Absolute path of a named backup, validated against path traversal. */
export async function backupFilePath(name: string): Promise<string> {
    const { dir } = await ensureBackupDir();
    return join(dir, safeName(name));
}

/** A filesystem-safe timestamp for backup filenames. */
function stamp(now: Date): string {
    return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

/** Read every model's rows into a `{ ModelName: rows[] }` map via the Prisma client. */
async function dumpAllTables(): Promise<Record<string, unknown[]>> {
    const client = prisma as unknown as Record<string, { findMany?: (args?: unknown) => Promise<unknown[]> }>;
    const out: Record<string, unknown[]> = {};
    for (const model of Prisma.dmmf.datamodel.models) {
        const key = model.name.charAt(0).toLowerCase() + model.name.slice(1);
        const delegate = client[key];
        if (delegate?.findMany) out[model.name] = await delegate.findMany();
    }
    return out;
}

/**
 * Create a database backup and return its file info: a gzipped JSON snapshot of
 * every table. BigInt columns are tagged so they round-trip; Bytes columns keep
 * Prisma's Buffer JSON shape. Restorable table-by-table.
 */
export async function createDatabaseBackup(): Promise<BackupInfo> {
    const { dir, ephemeral } = await ensureBackupDir();
    const at = new Date();
    const tables = await dumpAllTables();
    const payload = JSON.stringify(
        { format: "polaris-backup", version: 1, createdAt: at.toISOString(), tables },
        (_key, value) => (typeof value === "bigint" ? `__bigint__${value.toString()}` : value)
    );
    const name = `polaris-${stamp(at)}.json.gz`;
    await writeFile(join(dir, name), gzipSync(payload));
    const info = await stat(join(dir, name));
    return { name, kind: "database", sizeBytes: info.size, createdAt: at.toISOString(), ephemeral };
}

/** List existing backups, newest first. */
export async function listBackups(): Promise<BackupInfo[]> {
    const { dir, ephemeral } = await ensureBackupDir();
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    const rows = await Promise.all(
        names
            .filter((name) => name.endsWith(".json.gz") || name.endsWith(".dump") || name.endsWith(".db"))
            .map(async (name) => {
                const info = await stat(join(dir, name));
                return {
                    name,
                    kind: "database" as const,
                    sizeBytes: info.size,
                    createdAt: info.mtime.toISOString(),
                    ephemeral
                };
            })
    );
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Delete a backup file the operator no longer needs. */
export async function deleteBackup(name: string): Promise<void> {
    await rm(await backupFilePath(name), { force: true });
}

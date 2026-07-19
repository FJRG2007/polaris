/**
 * Backup service. The first target is the Polaris database - a one-click dump the
 * operator can take before a risky change (a migration, an upgrade) and download
 * or keep on the host. Backups are plain files under POLARIS_DATA_DIR/backups, so
 * the feature needs no schema of its own (and can therefore ship before a DB
 * migration). The structure is deliberately target-agnostic (`kind`) so NAS and,
 * later, other-app backups slot in beside the database one.
 *
 * Postgres backups use pg_dump's custom, compressed format (restore with
 * pg_restore); a SQLite dev database is simply file-copied. Node runtime.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadEnv } from "@polaris/config";

export type BackupKind = "database";

export interface BackupInfo {
    name: string;
    kind: BackupKind;
    sizeBytes: number;
    createdAt: string;
}

/** Directory that holds all backup artifacts on the host. */
function backupDir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "backups");
}

/** A filesystem-safe timestamp for backup filenames. */
function stamp(now: Date): string {
    return now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

/** Reject a caller-supplied backup name that tries to escape the backup dir. */
function safeName(name: string): string {
    if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new Error("Invalid backup name");
    }
    return name;
}

/** Absolute path of a named backup, validated against path traversal. */
export function backupPath(name: string): string {
    return join(backupDir(), safeName(name));
}

/**
 * Create a database backup and return its file info. Postgres is dumped with
 * pg_dump (custom format); a SQLite dev DB is copied. Throws with a clear message
 * if pg_dump is missing so the operator knows to install postgresql-client.
 */
export async function createDatabaseBackup(): Promise<BackupInfo> {
    const env = loadEnv();
    const dir = backupDir();
    await mkdir(dir, { recursive: true });
    const at = new Date();

    if (env.POLARIS_DB_PROVIDER === "sqlite") {
        const source = resolve(env.POLARIS_DATABASE_URL.replace(/^file:/, ""));
        const name = `polaris-${stamp(at)}.db`;
        await copyFile(source, join(dir, name));
        const info = await stat(join(dir, name));
        return { name, kind: "database", sizeBytes: info.size, createdAt: at.toISOString() };
    }

    const name = `polaris-${stamp(at)}.dump`;
    const target = join(dir, name);
    await new Promise<void>((res, rej) => {
        const out = createWriteStream(target);
        // pg_dump accepts the connection URI directly; -Fc is the compressed,
        // pg_restore-able custom format. --no-owner keeps it portable across roles.
        const proc = spawn("pg_dump", ["--no-owner", "-Fc", env.POLARIS_DATABASE_URL], {
            stdio: ["ignore", "pipe", "pipe"]
        });
        let stderr = "";
        proc.stdout.pipe(out);
        proc.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        proc.on("error", (error) =>
            rej(
                (error as NodeJS.ErrnoException).code === "ENOENT"
                    ? new Error("pg_dump is not installed on the host. Install postgresql-client to back up.")
                    : error
            )
        );
        proc.on("close", (code) => {
            out.close();
            if (code === 0) res();
            else rej(new Error(stderr.trim() || `pg_dump exited with code ${code}`));
        });
    });
    const info = await stat(target);
    return { name, kind: "database", sizeBytes: info.size, createdAt: at.toISOString() };
}

/** List existing backups, newest first. */
export async function listBackups(): Promise<BackupInfo[]> {
    const dir = backupDir();
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    const rows = await Promise.all(
        names
            .filter((name) => name.endsWith(".dump") || name.endsWith(".db"))
            .map(async (name) => {
                const info = await stat(join(dir, name));
                return {
                    name,
                    kind: "database" as const,
                    sizeBytes: info.size,
                    createdAt: info.mtime.toISOString()
                };
            })
    );
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Delete a backup file the operator no longer needs. */
export async function deleteBackup(name: string): Promise<void> {
    await rm(backupPath(name), { force: true });
}

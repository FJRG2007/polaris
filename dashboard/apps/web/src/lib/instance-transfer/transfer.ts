/**
 * Moving a whole Polaris to a fresh install: one file out of this one, into that.
 *
 * The file is every row of Polaris's own tables, one JSON line each, gzipped and
 * sealed under a passphrase (see `backups/sealing`). Secrets are opened on the way
 * out and sealed again on arrival under the new instance's keys (see `codec`), so
 * the file works on a machine with a different master key, and is useless without
 * the passphrase.
 *
 * Left behind on purpose: sign-in sessions, one-time codes and step-up proofs,
 * which mean nothing on another machine, and the rolling metrics and captured
 * output, which are history that rebuilds itself. The audit trail comes along, and
 * is sealed again from its first entry under the new key - its chain was keyed by
 * a master key the new instance does not have.
 *
 * Only onto a fresh install: importing replaces every row, including the account
 * doing it, and on an instance already in use that is a loss nobody should reach
 * by pressing a button. After it, everyone signs in with the accounts from the file.
 */

import { once } from "node:events";
import { loadEnv } from "@polaris/config";
import { prisma, Prisma } from "@polaris/db";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { keyFields, writePlan, type SchemaModel } from "./plan";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { decodeRow, encodeRow, type SecretCodec, type Tally } from "./codec";
import { newHeader, openStream, passphraseFileKey, SealError, sealStream } from "@/lib/backups/sealing";

export const TRANSFER_FORMAT = "polaris-instance";
const TRANSFER_VERSION = 1;
const PAGE = 500;

/** Tables that are not carried: meaningless elsewhere, or history that rebuilds. */
export const LEFT_BEHIND: ReadonlySet<string> = new Set([
    "Session",
    "SessionState",
    "Verification",
    "DeviceCode",
    "StepUpGrant",
    "RateLimitCounter",
    "GeoIpCache",
    "UploadSession",
    "LinkPreview",
    "MetricSample",
    "MetricRollup",
    "RuntimeLogLine",
    "GameSample",
    // The chain is sealed again under the new key from its first entry, so the
    // checkpoints of the old one would only contradict it.
    "AuditCheckpoint"
]);

/** Raised with a sentence for the screen: a wrong passphrase, a foreign file. */
export class TransferError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "TransferError";
    }
}

export interface TransferSummary {
    readonly exportedAt: string;
    /** Rows per table, in the order they are written. */
    readonly tables: readonly { readonly name: string; readonly rows: number }[];
    readonly carriedSecrets: number;
    /** Secrets that did not open where they were exported, and need entering again. */
    readonly unreadableSecrets: number;
    /** Tables in the file this Polaris does not have, whose rows are skipped. */
    readonly unknownTables: readonly string[];
}

function models(): SchemaModel[] {
    return Prisma.dmmf.datamodel.models as unknown as SchemaModel[];
}

type Delegate = {
    findMany(args: unknown): Promise<Record<string, unknown>[]>;
    createMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    deleteMany(args?: unknown): Promise<unknown>;
    count(args?: unknown): Promise<number>;
};

function delegateOf(client: unknown, model: string): Delegate {
    return (client as Record<string, Delegate>)[`${model.charAt(0).toLowerCase()}${model.slice(1)}`]!;
}

/** Secrets as this instance opens and seals them. */
export function instanceCodec(): SecretCodec {
    const env = loadEnv();
    return {
        open(blob) {
            try {
                return decryptSecret(blob, env.POLARIS_MASTER_KEY);
            } catch {
                return null;
            }
        },
        seal(plain) {
            return encryptSecret(plain, env.POLARIS_MASTER_KEY);
        },
        async openAuth(value) {
            try {
                return await symmetricDecrypt({ key: env.POLARIS_AUTH_SECRET, data: value });
            } catch {
                return null;
            }
        },
        sealAuth(plain) {
            return symmetricEncrypt({ key: env.POLARIS_AUTH_SECRET, data: plain });
        }
    };
}

/** Write one line, waiting when the stream asks to. */
async function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
    if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

/** Write this instance to `target`, sealed under `passphrase`. */
export async function exportInstance(passphrase: string, target: string): Promise<TransferSummary> {
    const all = models();
    const plan = writePlan(all);
    const byName = new Map(all.map((model) => [model.name, model]));
    const header = newHeader("passphrase");
    const gzip = createGzip();
    const done = pipeline(gzip, sealStream(header, passphraseFileKey(passphrase, header)), createWriteStream(target));
    const codec = instanceCodec();
    const tally: Tally = { carried: 0, unreadable: 0 };
    const tables: { name: string; rows: number }[] = [];
    const exportedAt = new Date().toISOString();
    try {
        await writeLine(gzip, { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, exportedAt });
        for (const name of plan.order) {
            if (LEFT_BEHIND.has(name)) continue;
            const model = byName.get(name)!;
            const orderBy = keyFields(model).map((field) => ({ [field]: "asc" }));
            let rows = 0;
            for (let skip = 0; ; skip += PAGE) {
                const page = await delegateOf(prisma, name).findMany({ orderBy, skip, take: PAGE });
                for (const row of page) await writeLine(gzip, { m: name, r: await encodeRow(model, row, codec, tally) });
                rows += page.length;
                if (page.length < PAGE) break;
            }
            tables.push({ name, rows });
        }
        const summary: TransferSummary = {
            exportedAt,
            tables,
            carriedSecrets: tally.carried,
            unreadableSecrets: tally.unreadable,
            unknownTables: []
        };
        await writeLine(gzip, { end: true, summary });
        gzip.end();
        await done;
        return summary;
    } catch (error) {
        gzip.destroy(error as Error);
        await done.catch(() => undefined);
        throw error;
    }
}

/** Every line of a transfer file, opened with `passphrase`. */
async function* linesOf(path: string, passphrase: string): AsyncGenerator<Record<string, unknown>> {
    const opener = openStream((header) => {
        if (header.kdf !== "passphrase") throw new TransferError("That is not a Polaris transfer file");
        return passphraseFileKey(passphrase, header);
    });
    const gunzip = createGunzip();
    // Any failure along the way destroys the last stream with it, which is what
    // ends the read below with that error rather than leaving it waiting.
    const piped = pipeline(createReadStream(path), opener, gunzip);
    piped.catch(() => undefined);
    // A character split across two chunks is held until its other half arrives.
    const decoder = new StringDecoder("utf8");
    let carry = "";
    try {
        for await (const chunk of gunzip) {
            carry += decoder.write(chunk as Buffer);
            let newline = carry.indexOf("\n");
            while (newline >= 0) {
                const line = carry.slice(0, newline);
                carry = carry.slice(newline + 1);
                if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
                newline = carry.indexOf("\n");
            }
        }
        await piped;
        if (carry.trim()) yield JSON.parse(carry) as Record<string, unknown>;
    } catch (error) {
        if (error instanceof SealError) throw new TransferError("The passphrase is wrong, or the file has been changed");
        if (error instanceof TransferError) throw error;
        throw new TransferError("That file could not be read as a Polaris transfer file");
    }
}

/** Read a transfer file through, checking every line, without writing anything. */
export async function previewTransfer(path: string, passphrase: string): Promise<TransferSummary> {
    const known = new Set(models().map((model) => model.name));
    let header: Record<string, unknown> | null = null;
    let trailer: TransferSummary | null = null;
    const counted = new Map<string, number>();
    for await (const line of linesOf(path, passphrase)) {
        if (!header) {
            if (line.format !== TRANSFER_FORMAT) throw new TransferError("That is not a Polaris transfer file");
            if (line.version !== TRANSFER_VERSION) throw new TransferError("That file was written by a different version of Polaris");
            header = line;
            continue;
        }
        if (line.end === true) {
            trailer = line.summary as TransferSummary;
            continue;
        }
        if (typeof line.m === "string") counted.set(line.m, (counted.get(line.m) ?? 0) + 1);
    }
    if (!header || !trailer) throw new TransferError("That file ends before it should - it may not have finished downloading");
    return {
        exportedAt: String(header.exportedAt),
        tables: [...counted.entries()].map(([name, rows]) => ({ name, rows })),
        carriedSecrets: trailer.carriedSecrets,
        unreadableSecrets: trailer.unreadableSecrets,
        unknownTables: [...counted.keys()].filter((name) => !known.has(name))
    };
}

/** What makes this instance not a fresh one, or null when it is. */
export async function notFreshReason(): Promise<string | null> {
    const [users, projects, servers] = await Promise.all([
        prisma.user.count(),
        prisma.project.count(),
        prisma.host.count()
    ]);
    if (users > 1) return "This Polaris already has other accounts. Import onto a fresh install.";
    if (projects > 0 || servers > 0) return "This Polaris already has projects or servers. Import onto a fresh install.";
    return null;
}

/**
 * Replace every row here with the file's. One transaction: it lands whole or not
 * at all. Previewed first by the caller; read again here, because a file on disk
 * is not a promise that nothing changed since.
 */
export async function applyTransfer(path: string, passphrase: string): Promise<TransferSummary> {
    const refused = await notFreshReason();
    if (refused) throw new TransferError(refused);
    const summary = await previewTransfer(path, passphrase);
    const all = models();
    const plan = writePlan(all);
    const byName = new Map(all.map((model) => [model.name, model]));
    const codec = instanceCodec();
    const provider = loadEnv().POLARIS_DB_PROVIDER;

    await prisma.$transaction(
        async (tx) => {
            if (provider === "postgresql") {
                const tables = all.map((model) => `"${model.dbName ?? model.name}"`).join(", ");
                await tx.$executeRawUnsafe(`TRUNCATE TABLE ${tables} CASCADE`);
            } else {
                await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
                for (const name of [...plan.order].reverse()) await delegateOf(tx, name).deleteMany();
            }

            const pending: { name: string; rows: Record<string, unknown>[] } = { name: "", rows: [] };
            const later: { name: string; where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
            const flush = async () => {
                if (pending.rows.length === 0) return;
                await delegateOf(tx, pending.name).createMany({ data: pending.rows });
                pending.rows = [];
            };
            let first = true;
            for await (const line of linesOf(path, passphrase)) {
                if (first) {
                    first = false;
                    continue;
                }
                if (typeof line.m !== "string") continue;
                const model = byName.get(line.m);
                if (!model || LEFT_BEHIND.has(model.name)) continue;
                const row = await decodeRow(model, line.r as Record<string, unknown>, codec);
                // A JSON column's empty value has to be said the database's way.
                for (const field of model.fields) {
                    if (field.type === "Json" && field.kind === "scalar" && row[field.name] === null) {
                        row[field.name] = Prisma.DbNull;
                    }
                }
                // The audit trail is sealed again here, from its first entry.
                if (model.name === "AuditLog") {
                    row.seq = null;
                    row.hash = null;
                }
                const deferred = plan.deferred.get(model.name) ?? [];
                const setLater = Object.fromEntries(deferred.filter((column) => row[column] != null).map((column) => [column, row[column]]));
                if (Object.keys(setLater).length > 0) {
                    for (const column of deferred) row[column] = null;
                    later.push({
                        name: model.name,
                        where: Object.fromEntries(keyFields(model).map((field) => [field, row[field]])),
                        data: setLater
                    });
                }
                if (pending.name !== model.name) await flush();
                pending.name = model.name;
                pending.rows.push(row);
                if (pending.rows.length >= PAGE) await flush();
            }
            await flush();
            for (const update of later) {
                const where = keyFields(byName.get(update.name)!).length > 1 ? compositeWhere(byName.get(update.name)!, update.where) : update.where;
                await delegateOf(tx, update.name).update({ where, data: update.data });
            }
        },
        { timeout: 60 * 60_000, maxWait: 30_000 }
    );
    return summary;
}

/** Prisma's shape for a composite primary key: `{ a_b: { a, b } }`. */
function compositeWhere(model: SchemaModel, key: Record<string, unknown>): Record<string, unknown> {
    const fields = keyFields(model);
    return { [fields.join("_")]: Object.fromEntries(fields.map((field) => [field, key[field]])) };
}

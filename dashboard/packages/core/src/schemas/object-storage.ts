/**
 * The rules of an S3-compatible object store Polaris runs: what a bucket may be
 * called, how an expiry rule is written for the engine, and what a service is
 * told to reach it.
 *
 * Pure, so the checks that stand between a typed name and a command inside the
 * store's container can be read in a test.
 */

import { z } from "zod";
import type { MaintenanceCommand } from "./database-maintenance.js";

/**
 * A bucket name S3 accepts and every client can address path-style: 3 to 63
 * characters, lower-case letters, digits and hyphens, starting and ending with
 * a letter or digit. Dots are refused on purpose - they are legal in S3 but
 * break virtual-hosted addressing over TLS, and they are the one character here
 * that could be read as a path by the engine's own shell.
 */
export function isBucketName(value: string): boolean {
    return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value) && !value.includes("--");
}

export const bucketNameSchema = z
    .string()
    .trim()
    .refine(isBucketName, "Use 3 to 63 lower-case letters, digits and single hyphens");

/** What a bucket key may do. */
export const BUCKET_ACCESS = ["readwrite", "readonly"] as const;
export type BucketAccess = (typeof BUCKET_ACCESS)[number];

/** The engine's action names for each, as `s3.configure -actions` takes them. */
export function bucketActions(access: BucketAccess): string {
    return access === "readonly" ? "Read,List" : "Read,Write,List,Tagging";
}

/** The ages an expiry rule can be set to, in days. */
export const LIFECYCLE_DAYS = [1, 7, 14, 30, 60, 90, 180, 365] as const;

/**
 * An expiry age as the engine's TTL: a number from 1 to 255 and a unit. Days
 * where they fit; a year as `1y`, since 365 days does not.
 */
export function lifecycleTtl(days: number): string {
    if (!Number.isInteger(days) || days < 1) throw new Error("An expiry is a whole number of days");
    if (days <= 255) return `${days}d`;
    if (days % 365 === 0 && days / 365 <= 255) return `${days / 365}y`;
    if (days % 7 === 0 && days / 7 <= 255) return `${days / 7}w`;
    throw new Error("That expiry is longer than the engine can hold");
}

/** A prefix inside a bucket: a relative path of safe characters, or nothing. */
export function isObjectPrefix(value: string): boolean {
    return value === "" || (/^[A-Za-z0-9._\/-]{1,512}$/.test(value) && !value.split("/").includes("..") && !value.startsWith("/"));
}

export const bucketCreateSchema = z.object({
    storeId: z.string().uuid(),
    name: bucketNameSchema
});

export const bucketKeySchema = z.object({
    bucketId: z.string().uuid(),
    name: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{1,40}$/, "Use up to 40 letters, digits and hyphens"),
    access: z.enum(BUCKET_ACCESS)
});

export const lifecycleRuleSchema = z.object({
    bucketId: z.string().uuid(),
    prefix: z.string().trim().refine(isObjectPrefix, "A prefix is a relative path inside the bucket"),
    days: z
        .number()
        .int()
        .refine((value) => (LIFECYCLE_DAYS as readonly number[]).includes(value), "Pick an offered age")
});

export const presignSchema = z.object({
    bucketId: z.string().uuid(),
    key: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "An object key is a relative path"),
    method: z.enum(["GET", "PUT"]),
    /** Seconds, up to the seven days SigV4 allows. */
    expiresIn: z.number().int().min(60).max(604_800),
    /** The address the URL is for, when not the store's own on the environment's
     *  network: a domain or published port that reaches it. A presigned URL is
     *  signed for one host and answers nowhere else. */
    baseUrl: z
        .string()
        .trim()
        .max(255)
        .optional()
        .refine((value) => value === undefined || value === "" || parseStoreBaseUrl(value) !== null, {
            message: "Use http:// or https:// and a host, with an optional port and nothing after it"
        })
});

/** An address a store is reached on: protocol and host (with its port), or null
 *  for anything else - a path, a query or credentials in it would not be signed. */
export function parseStoreBaseUrl(raw: string): { protocol: "http" | "https"; host: string } | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        return null;
    }
    return { protocol: url.protocol === "http:" ? "http" : "https", host: url.host };
}

export const bucketReplicationSchema = z.object({
    bucketId: z.string().uuid(),
    /** The bucket copies are written to, or null to stop replicating. */
    toBucketId: z.string().uuid().nullable()
});

/**
 * What a service is told to reach an object store through a reference
 * (`${{files.S3_ENDPOINT}}`): the generic names, and the AWS SDKs' own, which
 * every SDK reads without being configured.
 */
export function objectStorageReferenceKeys(connection: {
    readonly endpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly region: string;
}): Record<string, string> {
    return {
        S3_ENDPOINT: connection.endpoint,
        S3_ACCESS_KEY_ID: connection.accessKeyId,
        S3_SECRET_ACCESS_KEY: connection.secretAccessKey,
        S3_REGION: connection.region,
        S3_FORCE_PATH_STYLE: "true",
        AWS_ENDPOINT_URL_S3: connection.endpoint,
        AWS_ACCESS_KEY_ID: connection.accessKeyId,
        AWS_SECRET_ACCESS_KEY: connection.secretAccessKey,
        AWS_REGION: connection.region,
        URL: connection.endpoint
    };
}

/** The region an S3 client is told. The engine accepts any; clients insist on one. */
export const OBJECT_STORAGE_REGION = "us-east-1";

// ---------------------------------------------------------------------------
// The engine's own shell
// ---------------------------------------------------------------------------

/**
 * SeaweedFS is administered through `weed shell`, which reads commands one per
 * line. Each command here is a line of its own, passed to the script as a
 * positional argument and printed into the shell's input - never interpolated
 * into the script - and every value that reaches a line is checked first, so
 * nothing typed can add a second command to it.
 *
 * The shell answers a failed command with `error: ...` and carries on, and does
 * not always exit non-zero for it, so `weedShellFailure` reads the output.
 */
export function weedShellCommand(lines: readonly string[], describe: string): MaintenanceCommand {
    for (const line of lines) {
        if (/[\r\n]/.test(line)) throw new Error("A shell line cannot contain a line break");
    }
    return {
        argv: ["sh", "-c", 'printf "%s\\n" "$@" | weed shell -master=localhost:9333', "polaris", ...lines],
        describe
    };
}

/** The shell's output a line at a time, with any `> ` prompt it printed in front
 *  taken off - its errors go to stderr, and an exec that merges the two streams
 *  can land one right after a prompt. */
function shellLines(output: string): string[] {
    return output.split(/\r?\n/).map((entry) => entry.replace(/^(\s*>)+/, "").trim());
}

/** The first error the shell printed, or null when every command went through. */
export function weedShellFailure(output: string): string | null {
    const line = shellLines(output).find((entry) => /^error:/i.test(entry));
    return line ? line.replace(/^error:\s*/i, "").slice(0, 300) : null;
}

/** A value that may stand after `=` on a shell line: no spaces, no quotes. */
function shellToken(value: string, what: string): string {
    if (!/^[A-Za-z0-9._\/:,+-]{1,256}$/.test(value)) throw new Error(`${what} has characters the store cannot take`);
    return value;
}

/** The name the store's administrative identity is kept under. */
export const STORE_ADMIN_IDENTITY = "polaris-admin";

/**
 * Write an identity into the store's configuration: the administrative one, or
 * a key scoped to one bucket. An existing identity of the same name has the
 * actions and key added to it, so this is safe to run again.
 */
export function storeIdentityLine(identity: {
    readonly user: string;
    readonly accessKey: string;
    readonly secretKey: string;
    /** `Admin`, or the actions from `bucketActions`. */
    readonly actions: string;
    readonly bucket?: string;
}): string {
    const bucket = identity.bucket === undefined ? [] : [`-buckets=${shellToken(identity.bucket, "The bucket")}`];
    return [
        "s3.configure",
        `-user=${shellToken(identity.user, "The identity")}`,
        `-access_key=${shellToken(identity.accessKey, "The access key")}`,
        `-secret_key=${shellToken(identity.secretKey, "The secret key")}`,
        `-actions=${shellToken(identity.actions, "The actions")}`,
        ...bucket,
        "-apply"
    ].join(" ");
}

/** Remove an identity and every key it holds. */
export function storeIdentityDeleteLine(user: string): string {
    return `s3.configure -user=${shellToken(user, "The identity")} -delete -apply`;
}

/** The identity a bucket key is kept under - its access key, which is unique. */
export function bucketKeyIdentity(accessKey: string): string {
    return `key-${accessKey}`;
}

export function bucketCreateLine(name: string): string {
    if (!isBucketName(name)) throw new Error("That is not a bucket name");
    return `s3.bucket.create -name ${name}`;
}

export function bucketDeleteLine(name: string): string {
    if (!isBucketName(name)) throw new Error("That is not a bucket name");
    return `s3.bucket.delete -name ${name}`;
}

export const BUCKET_LIST_LINE = "s3.bucket.list";

/** The bucket names `s3.bucket.list` printed - one per line, the name first,
 *  indented, and then its size and other details after a tab. */
export function parseBucketList(output: string): string[] {
    return shellLines(output)
        .map((line) => line.split(/\s+/)[0] ?? "")
        .filter((name) => isBucketName(name));
}

/** A folder inside a bucket as the filer addresses it. */
function bucketPath(bucket: string, prefix: string): string {
    if (!isBucketName(bucket)) throw new Error("That is not a bucket name");
    if (!isObjectPrefix(prefix)) throw new Error("A prefix is a relative path inside the bucket");
    const tail = prefix === "" ? "" : prefix.endsWith("/") ? prefix : `${prefix}/`;
    return `/buckets/${bucket}/${tail}`;
}

/**
 * An expiry rule: objects written under the prefix from now on are removed once
 * they are `days` old. The engine keeps it as a TTL on the folder, which is how
 * its own S3 lifecycle support applies an expiration - and like that support it
 * governs objects written after the rule, not ones already there.
 */
export function lifecycleRuleLine(bucket: string, prefix: string, days: number): string {
    return `fs.configure -locationPrefix=${bucketPath(bucket, prefix)} -ttl=${lifecycleTtl(days)} -apply`;
}

export function lifecycleRuleDeleteLine(bucket: string, prefix: string): string {
    return `fs.configure -locationPrefix=${bucketPath(bucket, prefix)} -delete -apply`;
}

/** A stored expiry rule. */
export interface LifecycleRule {
    readonly prefix: string;
    readonly days: number;
}

/** Read a bucket's stored rules, dropping anything that is not one. */
export function parseLifecycleRules(raw: string): LifecycleRule[] {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown) => {
        const rule = entry as { prefix?: unknown; days?: unknown };
        return typeof rule?.prefix === "string" &&
            isObjectPrefix(rule.prefix) &&
            typeof rule.days === "number" &&
            Number.isInteger(rule.days) &&
            rule.days > 0
            ? [{ prefix: rule.prefix, days: rule.days }]
            : [];
    });
}

/** The filer's address inside a store: its container name and the filer port. */
export const FILER_PORT = 8888;

/**
 * Keep a replication running: one-way, every change under the source bucket
 * copied into the destination bucket of another store, by the engine's own
 * `filer.sync`. It runs inside the source store's container, detached, with its
 * process id written beside its log; the script starts it only when that process
 * is not already running, so the sweep that calls this is what restarts it after
 * the container is recreated. `filer.sync` keeps its position in the filer, so a
 * restart carries on from where it stopped rather than copying everything again.
 *
 * `-filerProxy` on both sides moves the data through the filers rather than
 * straight to each store's volume servers, whose addresses are not the ones the
 * other store can reach.
 */
export function replicationEnsureCommand(link: {
    readonly id: string;
    readonly sourceFiler: string;
    readonly targetFiler: string;
    readonly sourceBucket: string;
    readonly targetBucket: string;
}): MaintenanceCommand {
    if (!/^[0-9a-f-]{36}$/.test(link.id)) throw new Error("A replication is named by its bucket id");
    const script = [
        'pid=$(cat "$1" 2>/dev/null || true)',
        'if [ -n "$pid" ] && grep -q filer.sync "/proc/$pid/cmdline" 2>/dev/null; then echo running; exit 0; fi',
        'nohup weed filer.sync -a="$3" -b="$4" -a.path="$5" -b.path="$6" -isActivePassive -a.filerProxy -b.filerProxy > "$2" 2>&1 < /dev/null &',
        'echo $! > "$1"',
        "echo started"
    ].join("\n");
    return {
        argv: [
            "sh",
            "-c",
            script,
            "polaris",
            `/data/.polaris-sync-${link.id}.pid`,
            `/data/.polaris-sync-${link.id}.log`,
            `${shellToken(link.sourceFiler, "The source store")}:${FILER_PORT}`,
            `${shellToken(link.targetFiler, "The destination store")}:${FILER_PORT}`,
            bucketPath(link.sourceBucket, "").replace(/\/$/, ""),
            bucketPath(link.targetBucket, "").replace(/\/$/, "")
        ],
        describe: "Starting the replication"
    };
}

/** Stop a replication's process, when it is running. */
export function replicationStopCommand(id: string): MaintenanceCommand {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("A replication is named by its bucket id");
    return {
        argv: [
            "sh",
            "-c",
            'pid=$(cat "$1" 2>/dev/null || true); if [ -n "$pid" ] && grep -q filer.sync "/proc/$pid/cmdline" 2>/dev/null; then kill "$pid"; fi; rm -f "$1"',
            "polaris",
            `/data/.polaris-sync-${id}.pid`
        ],
        describe: "Stopping the replication"
    };
}

/** The last lines of a replication's log, for when it is found stopped. */
export function replicationLogCommand(id: string): MaintenanceCommand {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("A replication is named by its bucket id");
    return {
        argv: ["sh", "-c", 'tail -n 5 "$1" 2>/dev/null || true', "polaris", `/data/.polaris-sync-${id}.log`],
        describe: "Reading the replication log"
    };
}

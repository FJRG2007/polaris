/**
 * Object storage: the S3-compatible stores Polaris runs, and their buckets.
 *
 * A store is a managed database row whose engine is `seaweedfs` - deployed,
 * backed by a volume and reached by name exactly like a database - so everything
 * about where it runs and who may touch it is the database's. What is its own is
 * here: buckets, the keys scoped to one bucket, expiry rules, replication into a
 * bucket of another store, and presigned URLs.
 *
 * Every change is made through the engine's own shell inside the store's
 * container (see `weedShellCommand`), which reaches every server Polaris deploys
 * to the same way. The rows here are what Polaris asked for; the engine is told
 * first, and a row is written only once it has accepted.
 *
 * A key's secret is envelope-encrypted like every other credential and shown
 * once, when the key is made. It is never returned again and never logged.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import type { RuntimePorts } from "@polaris/deploy";
import { presignAwsUrl } from "@/lib/integrations/aws-sign";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";
import { generateAccessKey, generateSecretKey } from "@/lib/database-service";
import {
    DatabaseOperationError,
    instanceContext,
    lastLine,
    waitReady,
    withPorts,
    type InstanceContext
} from "@/lib/database-ops/ops";
import {
    bucketActions,
    bucketCreateLine,
    bucketDeleteLine,
    bucketKeyIdentity,
    lifecycleRuleDeleteLine,
    lifecycleRuleLine,
    parseLifecycleRules,
    parseStoreBaseUrl,
    replicationEnsureCommand,
    replicationLogCommand,
    replicationStopCommand,
    storeIdentityDeleteLine,
    storeIdentityLine,
    weedShellCommand,
    weedShellFailure,
    BUCKET_LIST_LINE,
    OBJECT_STORAGE_REGION,
    STORE_ADMIN_IDENTITY,
    parseBucketList,
    type BucketAccess,
    type LifecycleRule
} from "@polaris/core";

/** The S3 port every store answers on inside its network. */
const S3_PORT = 8333;

/** A store the owner holds, resolved with its container. */
async function storeContext(storeId: string, ownerId: string): Promise<InstanceContext> {
    const context = await instanceContext(storeId, ownerId);
    if (context.engine !== "seaweedfs")
        throw new DatabaseOperationError("That is not an object store.");
    return context;
}

/** The store a bucket belongs to, for the caller to check access against
 *  before anything else is read. */
export async function bucketStore(bucketId: string): Promise<{ storeId: string }> {
    const row = await prisma.objectBucket.findUnique({
        where: { id: bucketId },
        select: { storeId: true }
    });
    if (!row) throw new DatabaseOperationError("That bucket is not there any more.");
    return row;
}

/** A bucket the owner holds, with its store. */
async function ownedBucket(bucketId: string, ownerId: string) {
    const bucket = await prisma.objectBucket.findFirst({
        where: { id: bucketId, store: { environment: { project: { ownerId } } } }
    });
    if (!bucket) throw new DatabaseOperationError("That bucket is not there any more.");
    return bucket;
}

/**
 * Run lines through the store's shell, and throw with the engine's words when
 * any of them failed. Secrets on the lines are masked out of anything reported.
 */
async function shell(
    ports: RuntimePorts,
    context: InstanceContext,
    lines: readonly string[],
    describe: string,
    secrets: readonly string[] = []
): Promise<string> {
    const command = weedShellCommand(lines, describe);
    const result = await ports.runIn(context.container, command.argv);
    const failure = weedShellFailure(result.output);
    if (result.code !== 0 || failure) {
        const said = failure ?? lastLine(result.output);
        let masked = said;
        for (const secret of [...secrets, context.own.password])
            if (secret) masked = masked.split(secret).join("********");
        throw new DatabaseOperationError(`${describe} failed${masked ? `: ${masked}` : ""}`);
    }
    return result.output;
}

function decryptSecret(row: {
    encryptedSecret: Uint8Array;
    secretNonce: Uint8Array;
    secretKeyId: string;
}): string {
    return decryptCredentials<{ secret: string }>(
        {
            ciphertext: Buffer.from(row.encryptedSecret),
            nonce: Buffer.from(row.secretNonce),
            keyId: row.secretKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    ).secret;
}

/**
 * Write the store's administrative identity and every bucket key into its
 * configuration.
 *
 * Until a configuration exists the gateway authenticates with the identity its
 * container was started with; once one exists that is the only list it reads.
 * So the administrative identity goes in first, in the same pass, and the keys
 * after it. Safe to run again: each identity merges into itself.
 */
export async function ensureStoreIdentities(storeId: string, ownerId: string): Promise<void> {
    const context = await storeContext(storeId, ownerId);
    const keys = await prisma.objectBucketKey.findMany({
        where: { bucket: { storeId } },
        include: { bucket: { select: { name: true } } }
    });
    const secrets = keys.map((key) => ({ key, secret: decryptSecret(key) }));
    const lines = [
        storeIdentityLine({
            user: STORE_ADMIN_IDENTITY,
            accessKey: context.own.username,
            secretKey: context.own.password,
            actions: "Admin"
        }),
        ...secrets.map(({ key, secret }) =>
            storeIdentityLine({
                user: bucketKeyIdentity(key.accessKey),
                accessKey: key.accessKey,
                secretKey: secret,
                actions: bucketActions(key.access as BucketAccess),
                bucket: key.bucket.name
            })
        )
    ];
    await withPorts(context, async (ports) => {
        await waitReady(ports, context);
        await shell(
            ports,
            context,
            lines,
            "Writing the store's keys",
            secrets.map(({ secret }) => secret)
        );
        // Expiry rules live in the filer's configuration, which a store keeps on
        // its volume; they are written again anyway, so a store moved onto a new
        // volume ends up with the rules its buckets say it has.
        const buckets = await prisma.objectBucket.findMany({
            where: { storeId },
            select: { name: true, lifecycle: true }
        });
        const rules = buckets.flatMap((bucket) =>
            parseLifecycleRules(bucket.lifecycle).map((rule) =>
                lifecycleRuleLine(bucket.name, rule.prefix, rule.days)
            )
        );
        if (rules.length > 0) await shell(ports, context, rules, "Writing the expiry rules");
    });
}

export interface BucketView {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    readonly lifecycle: LifecycleRule[];
    readonly replicateTo: { id: string; name: string; storeName: string } | null;
    readonly replicationState: string;
    readonly replicationError: string | null;
    readonly keys: {
        id: string;
        name: string;
        access: string;
        accessKey: string;
        createdAt: string;
    }[];
}

/** A store's buckets as the screen shows them, with any bucket the engine has
 *  that Polaris did not make listed by name so it is not invisible. */
export async function listBuckets(
    storeId: string,
    ownerId: string
): Promise<{ buckets: BucketView[]; unmanaged: string[]; endpoint: string }> {
    const context = await storeContext(storeId, ownerId);
    const rows = await prisma.objectBucket.findMany({
        where: { storeId },
        orderBy: { name: "asc" },
        include: { keys: { orderBy: { createdAt: "asc" } } }
    });
    const targetIds = rows
        .map((row) => row.replicateToId)
        .filter((id): id is string => Boolean(id));
    const targets = targetIds.length
        ? await prisma.objectBucket.findMany({
              where: { id: { in: targetIds } },
              select: { id: true, name: true, store: { select: { name: true } } }
          })
        : [];
    const byId = new Map(targets.map((target) => [target.id, target]));
    let unmanaged: string[] = [];
    try {
        const output = await withPorts(context, (ports) =>
            shell(ports, context, [BUCKET_LIST_LINE], "Listing buckets")
        );
        const known = new Set(rows.map((row) => row.name));
        unmanaged = parseBucketList(output).filter((name) => !known.has(name));
    } catch {
        // A store that is down still has its buckets listed from here.
    }
    return {
        endpoint: `http://${context.container}:${S3_PORT}`,
        unmanaged,
        buckets: rows.map((row) => {
            const target = row.replicateToId ? byId.get(row.replicateToId) : undefined;
            return {
                id: row.id,
                name: row.name,
                createdAt: row.createdAt.toISOString(),
                lifecycle: parseLifecycleRules(row.lifecycle),
                replicateTo: target
                    ? { id: target.id, name: target.name, storeName: target.store.name }
                    : null,
                replicationState: row.replicationState,
                replicationError: row.replicationError,
                keys: row.keys.map((key) => ({
                    id: key.id,
                    name: key.name,
                    access: key.access,
                    accessKey: key.accessKey,
                    createdAt: key.createdAt.toISOString()
                }))
            };
        })
    };
}

export async function createBucket(
    storeId: string,
    ownerId: string,
    name: string
): Promise<{ id: string }> {
    const context = await storeContext(storeId, ownerId);
    const clash = await prisma.objectBucket.findFirst({
        where: { storeId, name },
        select: { id: true }
    });
    if (clash) throw new DatabaseOperationError(`This store already has a bucket called ${name}.`);
    await withPorts(context, (ports) =>
        shell(ports, context, [bucketCreateLine(name)], `Creating ${name}`)
    );
    return prisma.objectBucket.create({ data: { storeId, name }, select: { id: true } });
}

/**
 * Remove a bucket and everything in it. Its keys go with it, a replication out
 * of it is stopped, and a replication into it from another bucket is stopped
 * too - a copy has nowhere to land once its destination is gone.
 */
export async function deleteBucket(bucketId: string, ownerId: string): Promise<void> {
    const bucket = await ownedBucket(bucketId, ownerId);
    const context = await storeContext(bucket.storeId, ownerId);
    const keys = await prisma.objectBucketKey.findMany({
        where: { bucketId },
        select: { accessKey: true }
    });
    await withPorts(context, async (ports) => {
        if (bucket.replicateToId)
            await ports
                .runIn(context.container, replicationStopCommand(bucket.id).argv)
                .catch(() => undefined);
        const lines = [
            ...keys.map((key) => storeIdentityDeleteLine(bucketKeyIdentity(key.accessKey))),
            ...parseLifecycleRules(bucket.lifecycle).map((rule) =>
                lifecycleRuleDeleteLine(bucket.name, rule.prefix)
            ),
            bucketDeleteLine(bucket.name)
        ];
        await shell(ports, context, lines, `Removing ${bucket.name}`);
    });
    const feeding = await prisma.objectBucket.findMany({
        where: { replicateToId: bucketId },
        select: { id: true }
    });
    for (const source of feeding)
        await setReplication(source.id, ownerId, null).catch(() => undefined);
    await prisma.objectBucket.delete({ where: { id: bucketId } });
}

/**
 * A key that reaches one bucket. The secret is returned here and nowhere else:
 * the screen shows it once, and after that it exists only encrypted.
 */
export async function createBucketKey(
    bucketId: string,
    ownerId: string,
    input: { name: string; access: BucketAccess }
): Promise<{ id: string; accessKey: string; secretKey: string }> {
    const bucket = await ownedBucket(bucketId, ownerId);
    const clash = await prisma.objectBucketKey.findFirst({
        where: { bucketId, name: input.name },
        select: { id: true }
    });
    if (clash)
        throw new DatabaseOperationError(`This bucket already has a key called ${input.name}.`);
    const context = await storeContext(bucket.storeId, ownerId);
    const accessKey = generateAccessKey();
    const secretKey = generateSecretKey();
    await withPorts(context, (ports) =>
        shell(
            ports,
            context,
            [
                storeIdentityLine({
                    user: bucketKeyIdentity(accessKey),
                    accessKey,
                    secretKey,
                    actions: bucketActions(input.access),
                    bucket: bucket.name
                })
            ],
            "Creating the key",
            [secretKey]
        )
    );
    const blob = encryptCredentials({ secret: secretKey }, loadEnv().POLARIS_MASTER_KEY);
    const row = await prisma.objectBucketKey.create({
        data: {
            bucketId,
            name: input.name,
            access: input.access,
            accessKey,
            encryptedSecret: blob.ciphertext,
            secretNonce: blob.nonce,
            secretKeyId: blob.keyId
        },
        select: { id: true }
    });
    return { id: row.id, accessKey, secretKey };
}

export async function deleteBucketKey(
    bucketId: string,
    keyId: string,
    ownerId: string
): Promise<void> {
    const key = await prisma.objectBucketKey.findFirst({
        where: {
            id: keyId,
            bucketId,
            bucket: { store: { environment: { project: { ownerId } } } }
        },
        include: { bucket: { select: { storeId: true } } }
    });
    if (!key) throw new DatabaseOperationError("That key is not there any more.");
    const context = await storeContext(key.bucket.storeId, ownerId);
    await withPorts(context, (ports) =>
        shell(
            ports,
            context,
            [storeIdentityDeleteLine(bucketKeyIdentity(key.accessKey))],
            "Revoking the key"
        )
    );
    await prisma.objectBucketKey.delete({ where: { id: keyId } });
}

/** Add or change the expiry rule for one prefix. */
export async function setLifecycleRule(
    bucketId: string,
    ownerId: string,
    rule: LifecycleRule
): Promise<LifecycleRule[]> {
    const bucket = await ownedBucket(bucketId, ownerId);
    const context = await storeContext(bucket.storeId, ownerId);
    await withPorts(context, (ports) =>
        shell(
            ports,
            context,
            [lifecycleRuleLine(bucket.name, rule.prefix, rule.days)],
            "Setting the expiry rule"
        )
    );
    const rules = [
        ...parseLifecycleRules(bucket.lifecycle).filter((entry) => entry.prefix !== rule.prefix),
        rule
    ].sort((a, b) => a.prefix.localeCompare(b.prefix));
    await prisma.objectBucket.update({
        where: { id: bucketId },
        data: { lifecycle: JSON.stringify(rules) }
    });
    return rules;
}

export async function removeLifecycleRule(
    bucketId: string,
    ownerId: string,
    prefix: string
): Promise<LifecycleRule[]> {
    const bucket = await ownedBucket(bucketId, ownerId);
    const context = await storeContext(bucket.storeId, ownerId);
    await withPorts(context, (ports) =>
        shell(
            ports,
            context,
            [lifecycleRuleDeleteLine(bucket.name, prefix)],
            "Removing the expiry rule"
        )
    );
    const rules = parseLifecycleRules(bucket.lifecycle).filter((entry) => entry.prefix !== prefix);
    await prisma.objectBucket.update({
        where: { id: bucketId },
        data: { lifecycle: JSON.stringify(rules) }
    });
    return rules;
}

/**
 * A presigned URL for one object.
 *
 * Signed with the store's administrative key, which never leaves the server;
 * the URL itself allows only the one request it names until it expires. It is
 * signed for the host it will be used on - the store's own name on the
 * environment's network unless another address is given - and answers nowhere
 * else, which is the protocol, not a choice made here.
 */
export async function presignObject(
    bucketId: string,
    ownerId: string,
    input: { key: string; method: "GET" | "PUT"; expiresIn: number; baseUrl?: string }
): Promise<{ url: string; expiresAt: string }> {
    const bucket = await ownedBucket(bucketId, ownerId);
    const context = await storeContext(bucket.storeId, ownerId);
    const base = input.baseUrl ? parseStoreBaseUrl(input.baseUrl) : null;
    if (input.baseUrl && !base)
        throw new DatabaseOperationError("That address is not one a URL can be signed for.");
    const now = new Date();
    const url = presignAwsUrl({
        credentials: {
            accessKeyId: context.own.username,
            secretAccessKey: context.own.password,
            region: OBJECT_STORAGE_REGION
        },
        protocol: base?.protocol ?? "http",
        host: base?.host ?? `${context.container}:${S3_PORT}`,
        path: `/${bucket.name}/${input.key}`,
        method: input.method,
        expiresIn: input.expiresIn,
        now
    });
    return { url, expiresAt: new Date(now.getTime() + input.expiresIn * 1000).toISOString() };
}

/**
 * Replicate one bucket into a bucket of another store, or stop.
 *
 * Both stores have to be on the same server: the copy runs inside the source
 * store's container and reaches the destination by its name on that server's
 * network, and nothing here opens a path between two servers.
 */
export async function setReplication(
    bucketId: string,
    ownerId: string,
    toBucketId: string | null
): Promise<void> {
    const bucket = await ownedBucket(bucketId, ownerId);
    const context = await storeContext(bucket.storeId, ownerId);
    if (toBucketId === null) {
        // A store that is down has no process to stop; the row still stops
        // saying it replicates, so the sweep does not start one again.
        await withPorts(context, (ports) =>
            ports.runIn(context.container, replicationStopCommand(bucket.id).argv)
        ).catch(() => undefined);
        await prisma.objectBucket.update({
            where: { id: bucketId },
            data: { replicateToId: null, replicationState: "", replicationError: null }
        });
        return;
    }
    const target = await ownedBucket(toBucketId, ownerId);
    if (target.storeId === bucket.storeId) {
        throw new DatabaseOperationError(
            "Replicate into a bucket of another store - a copy inside the same store protects nothing."
        );
    }
    const targetContext = await storeContext(target.storeId, ownerId);
    if (targetContext.target.id !== context.target.id) {
        throw new DatabaseOperationError(
            "Both stores have to run on the same server to replicate between them."
        );
    }
    const loop = await prisma.objectBucket.findFirst({
        where: { id: toBucketId, replicateToId: bucketId },
        select: { id: true }
    });
    if (loop)
        throw new DatabaseOperationError(
            `${target.name} already replicates into ${bucket.name}; one direction only.`
        );
    if (bucket.replicateToId && bucket.replicateToId !== toBucketId) {
        await withPorts(context, (ports) =>
            ports.runIn(context.container, replicationStopCommand(bucket.id).argv)
        ).catch(() => undefined);
    }
    await prisma.objectBucket.update({
        where: { id: bucketId },
        data: { replicateToId: toBucketId }
    });
    await ensureReplication(bucketId);
}

/**
 * Start a bucket's replication when it is not running, and record how it was
 * found. What the sweep calls, and what setting one up calls once.
 */
async function ensureReplication(bucketId: string): Promise<"running" | "started" | "failed"> {
    const bucket = await prisma.objectBucket.findUnique({
        where: { id: bucketId },
        include: {
            store: {
                include: { environment: { select: { project: { select: { ownerId: true } } } } }
            }
        }
    });
    if (!bucket?.replicateToId) return "running";
    const ownerId = bucket.store.environment.project.ownerId;
    const target = await prisma.objectBucket.findUnique({
        where: { id: bucket.replicateToId },
        include: { store: { select: { containerName: true, status: true } } }
    });
    let state: "running" | "started" | "failed" = "failed";
    let error: string | null = null;
    try {
        if (!target) throw new DatabaseOperationError("The destination bucket is gone.");
        if (!bucket.store.containerName || !target.store.containerName) {
            throw new DatabaseOperationError("Both stores have to be deployed.");
        }
        const context = await storeContext(bucket.storeId, ownerId);
        const command = replicationEnsureCommand({
            id: bucket.id,
            sourceFiler: bucket.store.containerName,
            targetFiler: target.store.containerName,
            sourceBucket: bucket.name,
            targetBucket: target.name
        });
        state = await withPorts(context, async (ports) => {
            const result = await ports.runIn(context.container, command.argv);
            if (result.code !== 0)
                throw new DatabaseOperationError(
                    `Starting the replication failed: ${lastLine(result.output)}`
                );
            const answer = result.output.includes("started") ? "started" : "running";
            if (answer === "started") {
                // A process that dies at once (an address it cannot reach) is
                // found by looking a few seconds later rather than trusted.
                await new Promise((resolve) => setTimeout(resolve, 5000));
                const again = await ports.runIn(context.container, command.argv);
                if (again.output.includes("started")) {
                    const log = await ports.runIn(
                        context.container,
                        replicationLogCommand(bucket.id).argv
                    );
                    throw new DatabaseOperationError(
                        `The replication stopped as soon as it started: ${lastLine(log.output)}`
                    );
                }
            }
            return answer;
        });
    } catch (caught) {
        error =
            caught instanceof DatabaseOperationError
                ? caught.message
                : "The replication could not be started.";
        if (!(caught instanceof DatabaseOperationError))
            console.error(`object storage: replication of ${bucket.id} failed:`, caught);
    }
    await prisma.objectBucket.update({
        where: { id: bucketId },
        data: { replicationState: state === "failed" ? "failed" : "ok", replicationError: error }
    });
    return state;
}

/** Keep every replication running - the scheduled job. */
export async function sweepReplications(): Promise<{
    checked: number;
    restarted: number;
    failed: number;
}> {
    const rows = await prisma.objectBucket.findMany({
        where: { replicateToId: { not: null } },
        select: { id: true }
    });
    let restarted = 0;
    let failed = 0;
    for (const row of rows) {
        const state = await ensureReplication(row.id).catch(() => "failed" as const);
        if (state === "started") restarted += 1;
        if (state === "failed") failed += 1;
    }
    return { checked: rows.length, restarted, failed };
}

/** Restart the replications out of one store, after it was deployed again. */
export async function resumeStoreReplications(storeId: string): Promise<void> {
    const rows = await prisma.objectBucket.findMany({
        where: { storeId, replicateToId: { not: null } },
        select: { id: true }
    });
    for (const row of rows) await ensureReplication(row.id).catch(() => undefined);
}

/** The buckets of other stores on the same server that one could replicate into. */
export async function replicationCandidates(bucketId: string, ownerId: string) {
    const bucket = await ownedBucket(bucketId, ownerId);
    const store = await prisma.managedDatabase.findUnique({
        where: { id: bucket.storeId },
        select: { targetId: true, environment: { select: { projectId: true } } }
    });
    if (!store) return [];
    // The same project: access was checked for it, and for nothing wider.
    const rows = await prisma.objectBucket.findMany({
        where: {
            storeId: { not: bucket.storeId },
            store: {
                targetId: store.targetId,
                engine: "seaweedfs",
                environment: { projectId: store.environment.projectId, project: { ownerId } }
            }
        },
        select: { id: true, name: true, store: { select: { name: true } } },
        orderBy: { name: "asc" }
    });
    return rows.map((row) => ({ id: row.id, name: row.name, storeName: row.store.name }));
}

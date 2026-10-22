/**
 * Data engines that live in a cloud: connecting to one the user already has,
 * creating one where the provider documents an API for it, and deleting what
 * Polaris created.
 *
 * Such an instance is a `ManagedDatabase` row with `provider` set and no
 * container: its endpoint and credentials are held in the same encrypted blob
 * every database's credentials are, and it answers to the same reference keys
 * as a self-hosted one, so a service does not care where it lives.
 *
 * Every request leaves through `configuredRequest` with private addresses
 * refused: an endpoint is somebody's input, and a probe of this machine's own
 * network in disguise is the thing to stop.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as cloudamqp from "./cloudamqp";
import { CloudError, provisionFailure, type CloudErrorKey, type ProvisionFailure } from "./errors";
import { loadEnv } from "@polaris/config";
import { slugify } from "@polaris/deploy";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";
import { randomBytes } from "node:crypto";
import type { DbCredentials } from "@/lib/database-service";
import { signAwsRequest } from "@/lib/integrations/aws-sign";
import { assertEnvironmentRoom } from "@/lib/orgs/quota-service";
import { recipientShelf } from "@/lib/workspace-scope";
import { createNotification } from "@/lib/notification-service";
import { wordsFor } from "@/lib/notifications/notice-words";
import { configuredRequest, resolveName, RefusedAddressError } from "@/lib/safe-fetch";

const TEST_TIMEOUT_MS = 10_000;

/** A request to a public address only. */
export const publicRequest: cloudamqp.CloudFetch = (url, init) =>
    configuredRequest(url, { ...init, timeoutMs: TEST_TIMEOUT_MS }, { allowPrivate: false });

/** Refuses an address that is not public; the readable reason otherwise. */
async function answered(
    request: cloudamqp.CloudFetch,
    url: string,
    init: RequestInit,
    refused: CloudErrorKey
): Promise<Response> {
    let response: Response;
    try {
        response = await request(url, init);
    } catch (error) {
        if (error instanceof RefusedAddressError) throw new CloudError("privateAddress");
        throw new CloudError("nothingAnswered");
    }
    if (response.status === 401 || response.status === 403) throw new CloudError(refused);
    if (!response.ok) throw new CloudError("httpStatus", { status: response.status });
    return response;
}

/** Open a socket to a public address and close it: for the protocols that are
 *  not HTTP, proof that something listens there. */
async function socketOpens(host: string, port: number, tls: boolean): Promise<void> {
    const addresses = core.isIpAddress(host)
        ? [{ address: host }]
        : await resolveName(host).catch(() => []);
    if (addresses.length === 0) throw new CloudError("noResolve");
    if (addresses.some((one) => core.isPrivateIp(one.address)))
        throw new CloudError("privateAddress");
    const address = addresses[0]!.address;
    await new Promise<void>((resolve, reject) => {
        const socket = tls
            ? tlsConnect({
                  host: address,
                  port,
                  servername: core.isIpAddress(host) ? undefined : host
              })
            : tcpConnect({ host: address, port });
        const done = (error?: Error) => {
            socket.destroy();
            if (error) reject(error);
            else resolve();
        };
        socket.setTimeout(TEST_TIMEOUT_MS, () => done(new CloudError("nothingAnswered")));
        socket.once(tls ? "secureConnect" : "connect", () => done());
        socket.once("error", () => done(new CloudError("nothingAnswered")));
    });
}

/**
 * Test a connection before it is stored: the address answers, and - where the
 * engine has an HTTP API to ask - the credentials are accepted. Kafka, and a
 * RabbitMQ with no management address, are only checked to be listening: their
 * own protocols would need a client library this app does not carry.
 */
export async function testCloudConnection(
    input: core.CloudConnect,
    request: cloudamqp.CloudFetch = publicRequest,
    openSocket: typeof socketOpens = socketOpens
): Promise<void> {
    const e = core.cloudEndpoint(input);
    switch (input.engine) {
        case "minio": {
            const url = new URL(e.url);
            const path = `/${encodeURIComponent(e.database)}`;
            const signed = signAwsRequest({
                credentials: {
                    accessKeyId: e.username,
                    secretAccessKey: e.password,
                    region: e.region
                },
                service: "s3",
                host: url.host,
                method: "HEAD",
                path
            });
            await answered(
                request,
                `${e.url}${path}`,
                { method: "HEAD", headers: signed.headers },
                "keysRefused"
            );
            return;
        }
        case "meilisearch":
            await answered(
                request,
                `${e.url}/version`,
                { headers: { authorization: `Bearer ${e.token}` } },
                "keyRefused"
            );
            return;
        case "typesense":
            await answered(
                request,
                `${e.url}/collections`,
                { headers: { "x-typesense-api-key": e.token } },
                "keyRefused"
            );
            return;
        case "clickhouse":
            await answered(
                request,
                `${e.url}/?query=${encodeURIComponent("SELECT 1")}`,
                {
                    headers: {
                        "x-clickhouse-user": e.username,
                        "x-clickhouse-key": e.password,
                        "x-clickhouse-database": e.database
                    }
                },
                "userRefused"
            );
            return;
        case "influxdb": {
            const response = await answered(
                request,
                `${e.url}/api/v2/buckets?org=${encodeURIComponent(e.org)}&name=${encodeURIComponent(e.database)}`,
                { headers: { authorization: `Token ${e.token}` } },
                "tokenRefused"
            );
            const body = (await response.json().catch(() => ({}))) as { buckets?: unknown[] };
            if (!body.buckets?.length) throw new CloudError("noBucket");
            return;
        }
        case "couchdb": {
            const basic = Buffer.from(`${e.username}:${e.password}`).toString("base64");
            await answered(
                request,
                `${e.url}/_session`,
                { headers: { authorization: `Basic ${basic}` } },
                "userRefused"
            );
            return;
        }
        case "rabbitmq":
            if (e.managementUrl) {
                const basic = Buffer.from(`${e.username}:${e.password}`).toString("base64");
                await answered(
                    request,
                    `${e.managementUrl}/api/whoami`,
                    { headers: { authorization: `Basic ${basic}` } },
                    "userRefused"
                );
            } else {
                await openSocket(e.host, e.port, new URL(e.url).protocol === "amqps:");
            }
            return;
        case "kafka":
            await openSocket(e.host, e.port, e.securityProtocol.endsWith("SSL"));
            return;
    }
}

/** A row's name, unique in its environment, as `createDatabase` checks it. */
async function claimSlug(environmentId: string, name: string): Promise<string> {
    const slug = slugify(name);
    if (!slug) throw new CloudError("nameEmpty");
    await assertEnvironmentRoom(environmentId, "databases");
    const clash = await prisma.managedDatabase.findFirst({
        where: { environmentId, slug },
        select: { name: true }
    });
    if (clash) throw new CloudError("nameTaken", { name: clash.name });
    return slug;
}

function sealed(creds: DbCredentials) {
    const blob = encryptCredentials(creds, loadEnv().POLARIS_MASTER_KEY);
    return {
        encryptedCredential: blob.ciphertext,
        credentialNonce: blob.nonce,
        credentialKeyId: blob.keyId
    };
}

/** The columns every cloud row shares: no image, no container, no volume. */
function cloudRow(
    environmentId: string,
    targetId: string,
    name: string,
    slug: string,
    engine: string,
    provider: string
) {
    return {
        environmentId,
        targetId,
        name,
        slug,
        engine,
        provider,
        image: "",
        version: "",
        volumeName: "",
        containerName: ""
    };
}

/**
 * Store a connection to an instance the user already has, after testing it.
 * `targetId` is only there because the column is required: a cloud row is never
 * deployed to it.
 */
export async function connectCloudDatabase(
    ownerId: string,
    raw: core.CloudConnectInput,
    targetId: string,
    test: (input: core.CloudConnect) => Promise<void> = testCloudConnection
) {
    const input = core.cloudConnectSchema.parse(raw);
    const environment = await prisma.environment.findFirst({
        where: { id: input.environmentId, project: { ownerId } },
        select: { id: true }
    });
    if (!environment) throw new CloudError("environmentNotFound");
    const slug = await claimSlug(input.environmentId, input.name);
    await test(input);
    const endpoint = core.cloudEndpoint(input);
    return prisma.managedDatabase.create({
        data: {
            ...cloudRow(
                input.environmentId,
                targetId,
                input.name,
                slug,
                input.engine,
                input.provider
            ),
            status: "running",
            ...sealed({
                username: endpoint.username,
                password: endpoint.password,
                database: endpoint.database,
                cloud: { endpoint }
            })
        }
    });
}

/** How long a CloudAMQP create is followed, as its Terraform provider waits. */
export const CREATE_WAIT_MS = 30 * 60_000;
/** How often rows still being created are looked at. */
const POLL_MS = 15_000;

/** The endpoint of a ready CloudAMQP instance. */
function amqpEndpoint(url: string): core.DataEndpoint {
    return core.cloudEndpoint(
        core.cloudConnectSchema.parse({
            environmentId: "00000000-0000-4000-8000-000000000000",
            name: "cloudamqp",
            engine: "rabbitmq",
            provider: "cloudamqp",
            url
        })
    );
}

/**
 * Create a RabbitMQ in CloudAMQP with the user's API key.
 *
 * The row is written first, as provisioning, with everything the create needs
 * (key, plan, region, and the instance name it is created under there), so a
 * restart at any point leaves a row the watcher can carry on from. The name is
 * this row's own - `slug-<random>` - so finding it again by name can never adopt
 * an instance the user made themselves.
 */
export async function createCloudAmqpDatabase(
    ownerId: string,
    raw: core.CloudAmqpCreateInput,
    targetId: string,
    request: cloudamqp.CloudFetch = publicRequest
) {
    const input = core.cloudAmqpCreateSchema.parse(raw);
    const environment = await prisma.environment.findFirst({
        where: { id: input.environmentId, project: { ownerId } },
        select: { id: true }
    });
    if (!environment) throw new CloudError("environmentNotFound");
    const slug = await claimSlug(input.environmentId, input.name);
    const row = await prisma.managedDatabase.create({
        data: {
            ...cloudRow(input.environmentId, targetId, input.name, slug, "rabbitmq", "cloudamqp"),
            status: "provisioning",
            ...sealed({
                username: "",
                password: "",
                database: "",
                cloud: {
                    endpoint: core.cloudEndpointPlaceholder(),
                    apiKey: input.apiKey,
                    plan: input.plan,
                    region: input.region,
                    remoteName: `${slug}-${randomBytes(4).toString("hex")}`.slice(0, 60)
                }
            })
        }
    });
    // The first step now, so a refused key or plan is on screen at once and
    // the form can be sent again; the watcher takes every step after it.
    await advanceCloudProvision(row.id, request).catch(() => undefined);
    const after = await prisma.managedDatabase.findFirst({
        where: { id: row.id },
        select: { status: true, providerError: true }
    });
    if (after?.status === "failed") {
        await prisma.managedDatabase.deleteMany({ where: { id: row.id, status: "failed" } });
        throw new CloudError(`failed.${provisionFailure(after.providerError)}`);
    }
    return row;
}

/** Decrypt the blob of a row already loaded. */
function openSealed(row: {
    encryptedCredential: Uint8Array | null;
    credentialNonce: Uint8Array | null;
    credentialKeyId: string | null;
}): DbCredentials | null {
    if (!row.encryptedCredential || !row.credentialNonce) return null;
    return decryptCredentials<DbCredentials>(
        {
            ciphertext: Buffer.from(row.encryptedCredential),
            nonce: Buffer.from(row.credentialNonce),
            keyId: row.credentialKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** Mark a row failed with the reason the screen words, once: only from provisioning. */
async function failProvision(databaseId: string, reason: ProvisionFailure): Promise<void> {
    await prisma.managedDatabase.updateMany({
        where: { id: databaseId, status: "provisioning" },
        data: { status: "failed", providerError: reason }
    });
}

const inFlight = new Set<string>();

/**
 * Take one step on a row CloudAMQP is creating: create it there if that never
 * happened, otherwise ask whether it is ready, and store where it is once it
 * is. Every step can be repeated - the create finds its own instance by name,
 * and each write only moves a row that is still provisioning - so a restart, a
 * second tick or a retried request does no harm.
 */
export async function advanceCloudProvision(
    databaseId: string,
    request: cloudamqp.CloudFetch = publicRequest,
    now: Date = new Date()
): Promise<void> {
    if (inFlight.has(databaseId)) return;
    inFlight.add(databaseId);
    try {
        const row = await prisma.managedDatabase.findFirst({
            where: { id: databaseId, provider: "cloudamqp", status: "provisioning" }
        });
        if (!row) return;
        const cloud = openSealed(row)?.cloud;
        if (!cloud?.apiKey || !cloud.remoteName || !cloud.plan || !cloud.region) {
            await failProvision(row.id, "lost");
            return;
        }
        // Asked before giving up, so a create that finished while Polaris was
        // down is kept rather than called late.
        const late = now.getTime() - row.createdAt.getTime() > CREATE_WAIT_MS;
        let instance: cloudamqp.CloudAmqpInstance;
        try {
            if (row.providerResourceId) {
                instance = await cloudamqp.getCloudAmqpInstance(
                    request,
                    cloud.apiKey,
                    row.providerResourceId
                );
            } else {
                instance = await cloudamqp.createCloudAmqpInstance(request, cloud.apiKey, {
                    name: cloud.remoteName,
                    plan: cloud.plan,
                    region: cloud.region
                });
                if (instance.id) {
                    await prisma.managedDatabase.updateMany({
                        where: { id: row.id, providerResourceId: null },
                        data: { providerResourceId: instance.id }
                    });
                }
            }
        } catch (error) {
            // A refused key or a refused create will not fix itself; anything
            // else (a timeout, a 5xx) is tried again on the next tick, until
            // the wait is over.
            const key = error instanceof CloudError ? error.key : null;
            const status = error instanceof CloudError ? Number(error.params.status) : 0;
            if (key === "amqpKeyRefused") await failProvision(row.id, "keyRefused");
            else if (key === "amqpCreateFailed" && status >= 400 && status < 500) {
                await failProvision(row.id, "createRefused");
            } else if (late) await failProvision(row.id, "timeout");
            return;
        }
        if (!instance.ready || !instance.url) {
            if (late) await failProvision(row.id, "timeout");
            return;
        }
        const endpoint = amqpEndpoint(instance.url);
        await prisma.managedDatabase.updateMany({
            where: { id: row.id, status: "provisioning" },
            data: {
                status: "running",
                providerError: null,
                ...sealed({
                    username: endpoint.username,
                    password: endpoint.password,
                    database: endpoint.database,
                    cloud: { ...cloud, endpoint }
                })
            }
        });
    } finally {
        inFlight.delete(databaseId);
    }
}

/** One pass over every row still being created in a cloud. */
export async function resumeCloudProvisions(
    request: cloudamqp.CloudFetch = publicRequest,
    now: Date = new Date()
): Promise<void> {
    const rows = await prisma.managedDatabase.findMany({
        where: { provider: "cloudamqp", status: "provisioning", binnedAt: null },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: 50
    });
    for (const row of rows)
        await advanceCloudProvision(row.id, request, now).catch(() => undefined);
}

let watching = false;

/** Started once per process, after a predecessor has gone (see instrumentation). */
export function startCloudProvisionWatch(): void {
    if (watching) return;
    watching = true;
    const tick = () => void resumeCloudProvisions().catch(() => undefined);
    tick();
    setInterval(tick, POLL_MS).unref();
}

/** Wait for a step this process is taking on a row to finish, briefly. */
async function settled(databaseId: string): Promise<void> {
    for (let waited = 0; inFlight.has(databaseId) && waited < 4 * TEST_TIMEOUT_MS; waited += 200) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

/**
 * Remove what Polaris created in a cloud before its row goes; a connected
 * instance is left alone. A create still under way is stopped first, and an
 * instance whose id was never stored is found by the name it was created
 * under. A key CloudAMQP now refuses does not keep the row: it goes, and the
 * owner is told the instance may still be there.
 */
export async function removeCloudInstance(
    databaseId: string,
    owner: { readonly ownerId: string; readonly projectId: string; readonly orgId: string | null },
    request: cloudamqp.CloudFetch = publicRequest
): Promise<void> {
    await settled(databaseId);
    const stopped = await prisma.managedDatabase.updateMany({
        where: { id: databaseId, status: "provisioning" },
        data: { status: "deleting" }
    });
    const row = await prisma.managedDatabase.findFirst({ where: { id: databaseId } });
    if (row?.provider !== "cloudamqp") return;
    const cloud = openSealed(row)?.cloud;
    if (!cloud?.apiKey) return;
    try {
        const id =
            row.providerResourceId ??
            (cloud.remoteName
                ? (await cloudamqp.findCloudAmqpInstance(request, cloud.apiKey, cloud.remoteName))
                      ?.id
                : null);
        if (id) await cloudamqp.deleteCloudAmqpInstance(request, cloud.apiKey, id);
    } catch (error) {
        if (!(error instanceof CloudError && error.key === "amqpKeyRefused")) {
            if (stopped.count > 0) {
                await prisma.managedDatabase.updateMany({
                    where: { id: databaseId, status: "deleting" },
                    data: { status: "provisioning" }
                });
            }
            throw error;
        }
        const t = await wordsFor(owner.ownerId, "notices");
        await createNotification({
            userId: owner.ownerId,
            type: "deploy.cloud-left",
            title: t("cloudLeft.title", { name: row.name }),
            body: t("cloudLeft.body", { name: cloud.remoteName ?? row.name }),
            href: `/apps/deploy/${owner.projectId}`,
            shelf: await recipientShelf(owner.ownerId, { orgId: owner.orgId }),
            level: "warning",
            metadata: { databaseId, provider: row.provider }
        });
    }
}

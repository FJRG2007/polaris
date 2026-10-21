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
import { loadEnv } from "@polaris/config";
import { slugify } from "@polaris/deploy";
import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { encryptCredentials } from "@polaris/storage";
import type { DbCredentials } from "@/lib/database-service";
import { signAwsRequest } from "@/lib/integrations/aws-sign";
import { assertEnvironmentRoom } from "@/lib/orgs/quota-service";
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
    refused: string
): Promise<Response> {
    let response: Response;
    try {
        response = await request(url, init);
    } catch (error) {
        if (error instanceof RefusedAddressError) throw error;
        throw new Error("Nothing answered at that address");
    }
    if (response.status === 401 || response.status === 403) throw new Error(refused);
    if (!response.ok) throw new Error(`The server answered HTTP ${response.status}`);
    return response;
}

/** Open a socket to a public address and close it: for the protocols that are
 *  not HTTP, proof that something listens there. */
async function socketOpens(host: string, port: number, tls: boolean): Promise<void> {
    const addresses = core.isIpAddress(host)
        ? [{ address: host }]
        : await resolveName(host).catch(() => []);
    if (addresses.length === 0) throw new Error("That host name does not resolve");
    if (addresses.some((one) => core.isPrivateIp(one.address))) throw new RefusedAddressError();
    const address = addresses[0]!.address;
    await new Promise<void>((resolve, reject) => {
        const socket = tls
            ? tlsConnect({ host: address, port, servername: core.isIpAddress(host) ? undefined : host })
            : tcpConnect({ host: address, port });
        const done = (error?: Error) => {
            socket.destroy();
            if (error) reject(error);
            else resolve();
        };
        socket.setTimeout(TEST_TIMEOUT_MS, () => done(new Error("Nothing answered at that address")));
        socket.once(tls ? "secureConnect" : "connect", () => done());
        socket.once("error", () => done(new Error("Nothing answered at that address")));
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
                credentials: { accessKeyId: e.username, secretAccessKey: e.password, region: e.region },
                service: "s3",
                host: url.host,
                method: "HEAD",
                path
            });
            await answered(request, `${e.url}${path}`, { method: "HEAD", headers: signed.headers }, "The keys were refused, or they cannot reach that bucket");
            return;
        }
        case "meilisearch":
            await answered(request, `${e.url}/version`, { headers: { authorization: `Bearer ${e.token}` } }, "The key was refused");
            return;
        case "typesense":
            await answered(request, `${e.url}/collections`, { headers: { "x-typesense-api-key": e.token } }, "The API key was refused");
            return;
        case "clickhouse":
            await answered(
                request,
                `${e.url}/?query=${encodeURIComponent("SELECT 1")}`,
                { headers: { "x-clickhouse-user": e.username, "x-clickhouse-key": e.password, "x-clickhouse-database": e.database } },
                "The user or password was refused"
            );
            return;
        case "influxdb": {
            const response = await answered(
                request,
                `${e.url}/api/v2/buckets?org=${encodeURIComponent(e.org)}&name=${encodeURIComponent(e.database)}`,
                { headers: { authorization: `Token ${e.token}` } },
                "The token was refused"
            );
            const body = (await response.json().catch(() => ({}))) as { buckets?: unknown[] };
            if (!body.buckets?.length) throw new Error("That organization has no bucket by that name");
            return;
        }
        case "couchdb": {
            const basic = Buffer.from(`${e.username}:${e.password}`).toString("base64");
            await answered(request, `${e.url}/_session`, { headers: { authorization: `Basic ${basic}` } }, "The user or password was refused");
            return;
        }
        case "rabbitmq":
            if (e.managementUrl) {
                const basic = Buffer.from(`${e.username}:${e.password}`).toString("base64");
                await answered(request, `${e.managementUrl}/api/whoami`, { headers: { authorization: `Basic ${basic}` } }, "The user or password was refused");
            } else {
                await openSocket(e.host, e.port, new URL(e.url).protocol === "amqps:");
            }
            return;
        case "kafka":
            await openSocket(e.host, e.port, true);
            return;
    }
}

/** A row's name, unique in its environment, as `createDatabase` checks it. */
async function claimSlug(environmentId: string, name: string): Promise<string> {
    const slug = slugify(name);
    if (!slug) throw new Error("Database name must contain letters or digits");
    await assertEnvironmentRoom(environmentId, "databases");
    const clash = await prisma.managedDatabase.findFirst({
        where: { environmentId, slug },
        select: { name: true }
    });
    if (clash) throw new Error(`This environment already has a database called ${clash.name}`);
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
function cloudRow(environmentId: string, targetId: string, name: string, slug: string, engine: string, provider: string) {
    return { environmentId, targetId, name, slug, engine, provider, image: "", version: "", volumeName: "", containerName: "" };
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
    if (!environment) throw new Error("Environment not found");
    const slug = await claimSlug(input.environmentId, input.name);
    await test(input);
    const endpoint = core.cloudEndpoint(input);
    return prisma.managedDatabase.create({
        data: {
            ...cloudRow(input.environmentId, targetId, input.name, slug, input.engine, input.provider),
            status: "running",
            ...sealed({ username: endpoint.username, password: endpoint.password, database: endpoint.database, cloud: { endpoint } })
        }
    });
}

/** How long a CloudAMQP instance is waited on, as its Terraform provider does. */
const CREATE_WAIT_MS = 30 * 60_000;
const POLL_MS = 10_000;

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
 * Create a RabbitMQ in CloudAMQP with the user's API key, store the row as
 * provisioning, and follow it until CloudAMQP says it is ready.
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
    if (!environment) throw new Error("Environment not found");
    const slug = await claimSlug(input.environmentId, input.name);
    const instance = await cloudamqp.createCloudAmqpInstance(request, input.apiKey, input);
    const endpoint = instance.ready && instance.url ? amqpEndpoint(instance.url) : null;
    const row = await prisma.managedDatabase.create({
        data: {
            ...cloudRow(input.environmentId, targetId, input.name, slug, "rabbitmq", "cloudamqp"),
            providerResourceId: instance.id,
            status: endpoint ? "running" : "provisioning",
            ...sealed({
                username: endpoint?.username ?? "",
                password: endpoint?.password ?? "",
                database: endpoint?.database ?? "",
                cloud: { endpoint: endpoint ?? core.cloudEndpointPlaceholder(), apiKey: input.apiKey }
            })
        }
    });
    if (!endpoint) void followCloudAmqp(row.id, instance.id, input.apiKey, request);
    return row;
}

/** Poll until the instance is ready, then store where it is. */
export async function followCloudAmqp(
    databaseId: string,
    instanceId: string,
    apiKey: string,
    request: cloudamqp.CloudFetch = publicRequest,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
    const deadline = Date.now() + CREATE_WAIT_MS;
    while (Date.now() < deadline) {
        const instance = await cloudamqp.getCloudAmqpInstance(request, apiKey, instanceId).catch(() => null);
        if (instance?.ready && instance.url) {
            const endpoint = amqpEndpoint(instance.url);
            await prisma.managedDatabase.update({
                where: { id: databaseId },
                data: {
                    status: "running",
                    ...sealed({ username: endpoint.username, password: endpoint.password, database: endpoint.database, cloud: { endpoint, apiKey } })
                }
            });
            return;
        }
        await wait(POLL_MS);
    }
    await prisma.managedDatabase.update({ where: { id: databaseId }, data: { status: "failed" } });
}

/** Remove what Polaris created in a cloud; a connected instance is left alone. */
export async function deleteCloudInstance(
    provider: string,
    resourceId: string | null,
    creds: DbCredentials,
    request: cloudamqp.CloudFetch = publicRequest
): Promise<void> {
    if (provider === "cloudamqp" && resourceId && creds.cloud?.apiKey) {
        await cloudamqp.deleteCloudAmqpInstance(request, creds.cloud.apiKey, resourceId);
    }
}

/**
 * A CloudAMQP create that outlives the process that started it: every step is
 * taken from what the row holds, so a restart carries on instead of creating a
 * second instance, and a create that never finishes ends with a reason.
 *
 * Also the screen's half of the database grant: who is offered the form.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    name: string;
    provider: string;
    status: string;
    providerResourceId: string | null;
    providerError: string | null;
    createdAt: Date;
    binnedAt: Date | null;
    encryptedCredential: Uint8Array | null;
    credentialNonce: Uint8Array | null;
    credentialKeyId: string | null;
}

const rows = new Map<string, Row>();
const notices: { userId: string; title: string }[] = [];

const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value);

vi.mock("@polaris/db", () => ({
    prisma: {
        environment: { findFirst: async () => ({ id: "env-1" }) },
        managedDatabase: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                [...rows.values()].find((row) => matches(row, where)) ?? null,
            create: async ({ data }: { data: Partial<Row> }) => {
                const row = {
                    id: "db-new",
                    providerResourceId: null,
                    providerError: null,
                    createdAt: new Date(),
                    binnedAt: null,
                    ...data
                } as Row;
                rows.set(row.id, row);
                return row;
            },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                for (const row of [...rows.values()]) if (matches(row, where)) rows.delete(row.id);
                return { count: 0 };
            },
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                [...rows.values()].filter((row) => matches(row, where)).map((row) => ({ id: row.id })),
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
                let count = 0;
                for (const row of rows.values()) {
                    if (!matches(row, where)) continue;
                    Object.assign(row, data);
                    count += 1;
                }
                return { count };
            }
        }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test" }) }));
// Sealing is the storage package's business; here a blob is its JSON.
vi.mock("@polaris/storage", () => ({
    encryptCredentials: (value: unknown) => ({
        ciphertext: Buffer.from(JSON.stringify(value)),
        nonce: Buffer.from("n"),
        keyId: "k"
    }),
    decryptCredentials: (blob: { ciphertext: Buffer }) => JSON.parse(blob.ciphertext.toString())
}));
vi.mock("@/lib/orgs/quota-service", () => ({ assertEnvironmentRoom: async () => undefined }));
vi.mock("@/lib/workspace-scope", () => ({ recipientShelf: async () => "personal" }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string, params: Record<string, string>) => `${key} ${params.name}`
}));
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { userId: string; title: string }) => void notices.push(input)
}));

const service = await import("@/lib/data-cloud/service");
const { databaseFormAccess, offeredServiceTypes } = await import("@/app/(app)/apps/deploy/service-type-access");

const START = new Date("2026-10-21T10:00:00Z");

function provisioning(cloud: Record<string, unknown>, extra: Partial<Row> = {}): Row {
    const row: Row = {
        id: "db-1",
        name: "queue",
        provider: "cloudamqp",
        status: "provisioning",
        providerResourceId: null,
        providerError: null,
        createdAt: START,
        binnedAt: null,
        encryptedCredential: Buffer.from(JSON.stringify({ username: "", password: "", database: "", cloud })),
        credentialNonce: Buffer.from("n"),
        credentialKeyId: "k",
        ...extra
    };
    rows.set(row.id, row);
    return row;
}

const CLOUD = {
    endpoint: { url: "" },
    apiKey: "key-123",
    plan: "lemur",
    region: "amazon-web-services::us-east-1",
    remoteName: "queue-ab12cd34"
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const sealedOf = (row: Row) => JSON.parse(Buffer.from(row.encryptedCredential!).toString());

beforeEach(() => {
    rows.clear();
    notices.length = 0;
});

describe("a CloudAMQP create across restarts", () => {
    it("creates once, then only asks, then stores the address when ready", async () => {
        const row = provisioning(CLOUD);
        const first = vi
            .fn()
            .mockResolvedValueOnce(json([]))
            .mockResolvedValueOnce(json({ id: 42, ready: false }));
        await service.advanceCloudProvision(row.id, first, new Date(START.getTime() + 1000));
        expect(row.providerResourceId).toBe("42");
        expect(JSON.parse(first.mock.calls[1]![1].body).name).toBe("queue-ab12cd34");

        // A new process: the row is all it has.
        const later = vi.fn().mockResolvedValueOnce(json({ id: 42, ready: true, url: "amqps://u:p@host.rmq.cloudamqp.com/vh" }));
        await service.resumeCloudProvisions(later, new Date(START.getTime() + 60_000));
        expect(later).toHaveBeenCalledTimes(1);
        expect(later.mock.calls[0]![0]).toBe("https://customer.cloudamqp.com/api/instances/42");
        expect(later.mock.calls[0]![1].method).toBe("GET");
        expect(row.status).toBe("running");
        expect(sealedOf(row).cloud.endpoint).toMatchObject({ host: "host.rmq.cloudamqp.com", database: "vh", username: "u" });
        expect(sealedOf(row).cloud.apiKey).toBe("key-123");
    });

    it("finds its own instance again when the create landed but the id was never stored", async () => {
        const row = provisioning(CLOUD);
        const request = vi.fn().mockResolvedValueOnce(json([{ id: 9, name: "queue-ab12cd34", ready: false }]));
        await service.advanceCloudProvision(row.id, request, START);
        expect(request).toHaveBeenCalledTimes(1);
        expect(row.providerResourceId).toBe("9");
    });

    it("gives up with a reason after the deadline, once CloudAMQP says it is still not ready", async () => {
        const row = provisioning(CLOUD, { providerResourceId: "42" });
        const request = vi.fn().mockResolvedValueOnce(json({ id: 42, ready: false }));
        await service.advanceCloudProvision(row.id, request, new Date(START.getTime() + service.CREATE_WAIT_MS + 1));
        expect(request).toHaveBeenCalledTimes(1);
        expect(row.status).toBe("failed");
        expect(row.providerError).toBe("timeout");
    });

    it("keeps an instance that became ready while Polaris was down past the deadline", async () => {
        const row = provisioning(CLOUD, { providerResourceId: "42" });
        const request = vi.fn().mockResolvedValueOnce(json({ id: 42, ready: true, url: "amqps://u:p@host.rmq.cloudamqp.com/vh" }));
        await service.advanceCloudProvision(row.id, request, new Date(START.getTime() + 3 * service.CREATE_WAIT_MS));
        expect(row.status).toBe("running");
        expect(row.providerError).toBeNull();
    });

    it("fails at once on a refused key, and keeps trying on an outage", async () => {
        const refused = provisioning(CLOUD);
        await service.advanceCloudProvision(refused.id, vi.fn(async () => new Response("", { status: 401 })), START);
        expect(refused.status).toBe("failed");
        expect(refused.providerError).toBe("keyRefused");

        rows.clear();
        const down = provisioning(CLOUD, { providerResourceId: "42" });
        await service.advanceCloudProvision(down.id, vi.fn(async () => new Response("", { status: 503 })), START);
        expect(down.status).toBe("provisioning");
        expect(down.providerError).toBeNull();
    });

    it("answers a refused key on the form, and leaves no row behind", async () => {
        const request = vi.fn(async () => new Response("", { status: 401 }));
        await expect(
            service.createCloudAmqpDatabase(
                "owner-1",
                {
                    environmentId: "00000000-0000-4000-8000-000000000001",
                    name: "queue",
                    apiKey: "key-12345",
                    plan: "lemur",
                    region: "amazon-web-services::us-east-1"
                },
                "target-1",
                request
            )
        ).rejects.toMatchObject({ key: "failed.keyRefused" });
        expect(rows.size).toBe(0);
    });

    it("leaves a row that is no longer provisioning alone", async () => {
        const row = provisioning(CLOUD, { status: "running" });
        const request = vi.fn();
        await service.advanceCloudProvision(row.id, request, START);
        expect(request).not.toHaveBeenCalled();
    });
});

describe("deleting a CloudAMQP instance", () => {
    const OWNER = { ownerId: "owner-1", projectId: "project-1", orgId: null };

    it("finds an instance whose id was never stored by its name, and deletes it", async () => {
        const row = provisioning(CLOUD);
        const request = vi
            .fn()
            .mockResolvedValueOnce(json([{ id: 9, name: "queue-ab12cd34", ready: false }]))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        await service.removeCloudInstance(row.id, OWNER, request);
        expect(row.status).toBe("deleting");
        expect(request.mock.calls[1]![0]).toBe("https://customer.cloudamqp.com/api/instances/9");
        expect(request.mock.calls[1]![1].method).toBe("DELETE");
    });

    it("lets the row go on a refused key, and tells the owner the instance may remain", async () => {
        const row = provisioning(CLOUD, { status: "running", providerResourceId: "42" });
        await service.removeCloudInstance(row.id, OWNER, vi.fn(async () => new Response("", { status: 401 })));
        expect(notices).toEqual([expect.objectContaining({ userId: "owner-1", title: "cloudLeft.title queue" })]);
    });

    it("still refuses on an outage, so it can be tried again", async () => {
        const row = provisioning(CLOUD, { status: "running", providerResourceId: "42" });
        await expect(
            service.removeCloudInstance(row.id, OWNER, vi.fn(async () => new Response("", { status: 503 })))
        ).rejects.toMatchObject({ key: "amqpDeleteFailed" });
        expect(notices).toEqual([]);
    });

    it("hands a create it stopped back to the watcher when the delete fails", async () => {
        const row = provisioning(CLOUD);
        await expect(
            service.removeCloudInstance(row.id, OWNER, vi.fn(async () => new Response("", { status: 503 })))
        ).rejects.toMatchObject({ key: "amqpListFailed" });
        expect(row.status).toBe("provisioning");
    });
});

describe("who is offered the database form", () => {
    const TYPES = [{ id: "github" }, { id: "database" }];

    it("hides the database kind without the database grant", () => {
        expect(offeredServiceTypes(TYPES, () => false).map((type) => type.id)).toEqual(["github"]);
        expect(offeredServiceTypes(TYPES, () => true).map((type) => type.id)).toEqual(["github", "database"]);
    });

    it("names the grant that is missing", () => {
        expect(databaseFormAccess(false, () => true)).toEqual({ allowed: false, reason: "deployManage" });
        expect(databaseFormAccess(true, () => false)).toEqual({ allowed: false, reason: "databasesManage" });
        expect(databaseFormAccess(true, () => true)).toEqual({ allowed: true });
    });
});

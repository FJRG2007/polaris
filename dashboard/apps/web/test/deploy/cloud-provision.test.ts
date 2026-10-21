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

const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value);

vi.mock("@polaris/db", () => ({
    prisma: {
        managedDatabase: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                [...rows.values()].find((row) => matches(row, where)) ?? null,
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

const service = await import("@/lib/data-cloud/service");
const { databaseFormAccess, offeredServiceTypes } = await import("@/app/(app)/apps/deploy/service-type-access");

const START = new Date("2026-10-21T10:00:00Z");

function provisioning(cloud: Record<string, unknown>, extra: Partial<Row> = {}): Row {
    const row: Row = {
        id: "db-1",
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

beforeEach(() => rows.clear());

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

    it("gives up with a reason after the deadline", async () => {
        const row = provisioning(CLOUD, { providerResourceId: "42" });
        const request = vi.fn();
        await service.advanceCloudProvision(row.id, request, new Date(START.getTime() + service.CREATE_WAIT_MS + 1));
        expect(request).not.toHaveBeenCalled();
        expect(row.status).toBe("failed");
        expect(row.providerError).toMatch(/within 30 minutes/);
    });

    it("fails at once on a refused key, and keeps trying on an outage", async () => {
        const refused = provisioning(CLOUD);
        await service.advanceCloudProvision(refused.id, vi.fn(async () => new Response("", { status: 401 })), START);
        expect(refused.status).toBe("failed");
        expect(refused.providerError).toMatch(/refused the API key/);

        rows.clear();
        const down = provisioning(CLOUD, { providerResourceId: "42" });
        await service.advanceCloudProvision(down.id, vi.fn(async () => new Response("", { status: 503 })), START);
        expect(down.status).toBe("provisioning");
        expect(down.providerError).toBeNull();
    });

    it("leaves a row that is no longer provisioning alone", async () => {
        const row = provisioning(CLOUD, { status: "running" });
        const request = vi.fn();
        await service.advanceCloudProvision(row.id, request, START);
        expect(request).not.toHaveBeenCalled();
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

/**
 * A create at a managed host (Neon, Supabase, Upstash) through the same
 * lifecycle as the CloudAMQP one: the row first, one step at a time from what it
 * holds, a refusal said in the words of the provider, and a delete that removes
 * what was created there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    engine?: string;
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
    Object.entries(where).every(
        ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value
    );

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
                [...rows.values()]
                    .filter((row) => matches(row, where))
                    .map((row) => ({ id: row.id })),
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Partial<Row>;
            }) => {
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
const START = new Date("2026-10-21T10:00:00Z");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const sealedOf = (row: Row) => JSON.parse(Buffer.from(row.encryptedCredential!).toString());
const OWNER = { ownerId: "u-1", projectId: "p-1", orgId: null };
const ENV = "00000000-0000-4000-8000-000000000001";

function provisioning(provider: string, cloud: Record<string, unknown>): Row {
    const row: Row = {
        id: "db-1",
        name: "cache",
        provider,
        status: "provisioning",
        providerResourceId: null,
        providerError: null,
        createdAt: START,
        binnedAt: null,
        encryptedCredential: Buffer.from(
            JSON.stringify({ username: "", password: "", database: "", cloud })
        ),
        credentialNonce: Buffer.from("n"),
        credentialKeyId: "k"
    };
    rows.set(row.id, row);
    return row;
}

const UPSTASH = {
    endpoint: { url: "" },
    apiKey: "key-123",
    account: "me@example.com",
    region: "us-east-1",
    remoteName: "cache-ab12cd34"
};
const upstashDb = (state: string) => ({
    database_id: "db-9",
    database_name: "cache-ab12cd34",
    endpoint: "fine-cat-1.upstash.io",
    port: 6379,
    password: "pw",
    state,
    tls: true
});

beforeEach(() => {
    rows.clear();
    notices.length = 0;
});

describe("a managed-host create across restarts", () => {
    it("stores the id at once, then the address when the provider says ready", async () => {
        const row = provisioning("upstash", UPSTASH);
        const first = vi
            .fn()
            .mockResolvedValueOnce(json([]))
            .mockResolvedValueOnce(json(upstashDb("passive")));
        await service.advanceCloudProvision(row.id, first, new Date(START.getTime() + 1000));
        expect(row.providerResourceId).toBe("db-9");
        expect(row.status).toBe("provisioning");

        const next = vi.fn().mockResolvedValueOnce(json([upstashDb("active")]));
        await service.advanceCloudProvision(row.id, next, new Date(START.getTime() + 2000));
        expect(next).toHaveBeenCalledTimes(1);
        expect(row.status).toBe("running");
        expect(sealedOf(row).cloud.endpoint.url).toBe("rediss://:pw@fine-cat-1.upstash.io:6379");
        expect(sealedOf(row).password).toBe("pw");
    });

    it("gives up after the deadline with a reason", async () => {
        const row = provisioning("upstash", UPSTASH);
        row.providerResourceId = "db-9";
        const late = new Date(START.getTime() + service.CREATE_WAIT_MS + 1);
        await service.advanceCloudProvision(
            row.id,
            vi.fn().mockResolvedValueOnce(json([upstashDb("passive")])),
            late
        );
        expect(row.status).toBe("failed");
        expect(row.providerError).toBe("timeout");
    });

    it("keeps trying through an outage", async () => {
        const row = provisioning("upstash", UPSTASH);
        await service.advanceCloudProvision(
            row.id,
            vi.fn().mockRejectedValueOnce(new Error("socket hang up")),
            new Date(START.getTime() + 1000)
        );
        expect(row.status).toBe("provisioning");
    });

    it("answers the form in the words of Neon, and leaves no row behind", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(json({ message: "project limit reached" }, 422));
        const error = await service
            .createCloudDatabase(
                "u-1",
                {
                    environmentId: ENV,
                    name: "Main DB",
                    provider: "neon",
                    apiKey: "key-12345678",
                    region: "aws-us-east-2"
                },
                "target-1",
                fetch
            )
            .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
            key: "providerRefused",
            params: { provider: "Neon", message: "project limit reached" }
        });
        expect(rows.size).toBe(0);
    });

    it("runs a Neon project as soon as it is created", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(
            json({
                project: { id: "proj-1" },
                connection_uris: [{ connection_uri: "postgresql://o:pw@ep-1.neon.tech/neondb" }]
            })
        );
        const row = await service.createCloudDatabase(
            "u-1",
            {
                environmentId: ENV,
                name: "Main DB",
                provider: "neon",
                apiKey: "key-12345678",
                region: "aws-us-east-2"
            },
            "target-1",
            fetch
        );
        const stored = rows.get(row.id)!;
        expect(stored.engine).toBe("postgres");
        expect(stored.status).toBe("running");
        expect(stored.providerResourceId).toBe("proj-1");
        expect(sealedOf(stored).cloud.endpoint.database).toBe("neondb");
    });

    it("chooses and keeps a database password for Supabase", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(json({ ref: "abc", status: "COMING_UP" }));
        const row = await service.createCloudDatabase(
            "u-1",
            {
                environmentId: ENV,
                name: "Main DB",
                provider: "supabase",
                apiKey: "key-12345678",
                account: "my-org",
                region: "us-east-1"
            },
            "target-1",
            fetch
        );
        const sent = JSON.parse(fetch.mock.calls[0]![1].body as string);
        expect(sent.db_pass).toHaveLength(32);
        expect(sealedOf(rows.get(row.id)!).cloud.dbPassword).toBe(sent.db_pass);
    });
});

describe("deleting what a managed host created", () => {
    it("finds an Upstash database whose id was never stored by its name, and deletes it", async () => {
        const row = provisioning("upstash", UPSTASH);
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(json([upstashDb("active")]))
            .mockResolvedValueOnce(json("OK"));
        await service.removeCloudInstance(row.id, OWNER, fetch);
        expect(fetch.mock.calls[1]![0]).toBe("https://api.upstash.com/v2/redis/database/db-9");
    });

    it("lets the row go on a refused key, and tells the owner it may remain", async () => {
        const row = provisioning("neon", { ...UPSTASH, account: "" });
        row.providerResourceId = "proj-1";
        await service.removeCloudInstance(
            row.id,
            OWNER,
            vi.fn().mockResolvedValueOnce(json({}, 401))
        );
        expect(notices).toHaveLength(1);
    });

    it("still refuses on an outage, and hands the create back to the watcher", async () => {
        const row = provisioning("supabase", UPSTASH);
        row.providerResourceId = "abc";
        await expect(
            service.removeCloudInstance(row.id, OWNER, vi.fn().mockResolvedValueOnce(json({}, 503)))
        ).rejects.toMatchObject({ key: "providerStatus" });
        expect(row.status).toBe("provisioning");
    });
});

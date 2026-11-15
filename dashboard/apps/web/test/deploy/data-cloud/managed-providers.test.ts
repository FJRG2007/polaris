/**
 * The managed hosts a database can be created at - Neon, Supabase, Upstash -
 * each against a mocked fetch: what is sent, how the answer is read, and how a
 * refusal is said. Also which providers the "where it runs" choice lists.
 */

import * as core from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import { CloudError } from "@/lib/data-cloud/errors";
import { neon, NEON_API } from "@/lib/data-cloud/neon";
import { providerMessage } from "@/lib/data-cloud/managed";
import { supabase, SUPABASE_API } from "@/lib/data-cloud/supabase";
import { upstash, UPSTASH_API, upstashPlatform } from "@/lib/data-cloud/upstash";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const bodyOf = (fetch: ReturnType<typeof vi.fn>, call = 0) =>
    JSON.parse(fetch.mock.calls[call]![1].body as string);
const headerOf = (fetch: ReturnType<typeof vi.fn>, call = 0) =>
    fetch.mock.calls[call]![1].headers as Record<string, string>;

async function refusal(promise: Promise<unknown>): Promise<CloudError> {
    const error = await promise.then(
        () => null,
        (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(CloudError);
    return error as CloudError;
}

describe("the where-it-runs choice", () => {
    const ids = (engine: string) => core.cloudProvidersFor(engine).map((one) => one.id);

    it("offers Neon and Supabase for PostgreSQL", () => {
        expect(ids("postgres")).toEqual(["neon", "supabase", "other"]);
    });
    it("offers MongoDB Atlas for MongoDB, to connect", () => {
        expect(ids("mongo")).toEqual(["mongodb-atlas", "other"]);
        expect(core.DATA_CLOUD_PROVIDERS.find((one) => one.id === "mongodb-atlas")?.create).toBe(
            false
        );
    });
    it("offers Upstash for Redis", () => {
        expect(ids("redis")).toEqual(["upstash", "other"]);
    });
    it("leaves ClickHouse's choice as it was", () => {
        expect(ids("clickhouse")).toEqual(["clickhouse-cloud", "aiven", "other"]);
    });
    it("offers no cloud for an engine no host is listed for", () => {
        expect(core.isCloudEngine("mysql")).toBe(false);
        expect(ids("mysql")).toEqual([]);
    });
    it("marks the create providers as creatable", () => {
        for (const id of core.CLOUD_CREATE_PROVIDERS) {
            expect(core.DATA_CLOUD_PROVIDERS.find((one) => one.id === id)?.create).toBe(true);
        }
    });
});

describe("connecting to a managed PostgreSQL, MongoDB or Redis", () => {
    const base = { environmentId: "00000000-0000-4000-8000-000000000001", name: "db" };

    it("reads the account and database out of a PostgreSQL string", () => {
        const input = core.cloudConnectSchema.parse({
            ...base,
            engine: "postgres",
            provider: "neon",
            url: "postgresql://app:s%40cret@ep-1.us-east-2.aws.neon.tech/neondb?sslmode=require"
        });
        const endpoint = core.cloudEndpoint(input);
        expect(endpoint).toMatchObject({
            host: "ep-1.us-east-2.aws.neon.tech",
            port: 5432,
            username: "app",
            password: "s@cret",
            database: "neondb"
        });
    });
    it("takes an SRV string for Atlas", () => {
        const parsed = core.cloudConnectSchema.safeParse({
            ...base,
            engine: "mongo",
            provider: "mongodb-atlas",
            url: "mongodb+srv://u:p@cluster0.abcde.mongodb.net/app"
        });
        expect(parsed.success).toBe(true);
    });
    it("refuses the wrong scheme with words for this engine", () => {
        const parsed = core.cloudConnectSchema.safeParse({
            ...base,
            engine: "redis",
            provider: "upstash",
            url: "https://example.upstash.io"
        });
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.message).toBe("view.database.cloud.issues.urlRedis");
    });
    it("refuses a provider that does not offer the engine", () => {
        const parsed = core.cloudConnectSchema.safeParse({
            ...base,
            engine: "redis",
            provider: "neon",
            url: "rediss://:p@h:6379"
        });
        expect(parsed.success).toBe(false);
    });
});

describe("a create's form", () => {
    const base = {
        environmentId: "00000000-0000-4000-8000-000000000001",
        name: "db",
        apiKey: "key-12345678"
    };
    it("asks Supabase for the organization and Upstash for an email", () => {
        expect(
            core.cloudCreateSchema.safeParse({ ...base, provider: "supabase", region: "us-east-1" })
                .success
        ).toBe(false);
        expect(
            core.cloudCreateSchema.safeParse({
                ...base,
                provider: "upstash",
                account: "not-an-email",
                region: "us-east-1"
            }).success
        ).toBe(false);
        expect(
            core.cloudCreateSchema.safeParse({ ...base, provider: "neon", region: "aws-us-east-2" })
                .success
        ).toBe(true);
    });
    it("lower-cases an Upstash email", () => {
        const parsed = core.cloudCreateSchema.parse({
            ...base,
            provider: "upstash",
            account: " Me@Example.COM ",
            region: "us-east-1"
        });
        expect(parsed.account).toBe("me@example.com");
    });
});

const CLOUD = { apiKey: "key-123", remoteName: "db-ab12cd34", region: "aws-us-east-2" };

describe("Neon", () => {
    it("creates a project and reads its connection URI", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(
            json(
                {
                    project: { id: "proj-1" },
                    connection_uris: [
                        { connection_uri: "postgresql://owner:pw@ep-1.neon.tech/neondb" }
                    ]
                },
                201
            )
        );
        const instance = await neon.create(fetch, { ...CLOUD, account: "org-1" });
        expect(fetch.mock.calls[0]![0]).toBe(`${NEON_API}/projects`);
        expect(fetch.mock.calls[0]![1].method).toBe("POST");
        expect(headerOf(fetch).authorization).toBe("Bearer key-123");
        expect(bodyOf(fetch)).toEqual({
            project: { name: "db-ab12cd34", region_id: "aws-us-east-2", org_id: "org-1" }
        });
        expect(instance).toMatchObject({ id: "proj-1", ready: true });
        expect(instance.endpoint).toMatchObject({ host: "ep-1.neon.tech", password: "pw" });
    });
    it("leaves the organization out when none was given", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(
            json({ project: { id: "p" }, connection_uris: [{ connection_uri: "postgresql://a:b@h/d" }] })
        );
        await neon.create(fetch, CLOUD);
        expect(bodyOf(fetch).project).not.toHaveProperty("org_id");
    });
    it("says a refused key, and Neon's own words for anything else", async () => {
        const refused = await refusal(
            neon.create(vi.fn().mockResolvedValueOnce(json({ message: "nope" }, 401)), CLOUD)
        );
        expect(refused.key).toBe("providerKeyRefused");
        expect(refused.params.provider).toBe("Neon");
        const said = await refusal(
            neon.create(
                vi.fn().mockResolvedValueOnce(json({ message: "region not supported" }, 422)),
                CLOUD
            )
        );
        expect(said.key).toBe("providerRefused");
        expect(said.params).toMatchObject({ status: 422, message: "region not supported" });
    });
    it("refuses an answer that is not what the documentation describes", async () => {
        const error = await refusal(
            neon.create(vi.fn().mockResolvedValueOnce(json({ project: {} })), CLOUD)
        );
        expect(error.key).toBe("providerUnreadable");
    });
    it("deletes a project, and counts one already gone as deleted", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }));
        await neon.remove(fetch, CLOUD, "proj-1");
        expect(fetch.mock.calls[0]![0]).toBe(`${NEON_API}/projects/proj-1`);
        expect(fetch.mock.calls[0]![1].method).toBe("DELETE");
    });
});

describe("Supabase", () => {
    const cloud = { ...CLOUD, region: "us-east-1", account: "my-org", dbPassword: "p@ss" };

    it("creates a project with the password Polaris chose", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(json({ ref: "abcdefghij", status: "COMING_UP" }, 201));
        const instance = await supabase.create(fetch, cloud);
        expect(fetch.mock.calls[0]![0]).toBe(`${SUPABASE_API}/projects`);
        expect(headerOf(fetch).authorization).toBe("Bearer key-123");
        expect(bodyOf(fetch)).toEqual({
            name: "db-ab12cd34",
            db_pass: "p@ss",
            organization_slug: "my-org",
            region: "us-east-1"
        });
        expect(instance).toEqual({ id: "abcdefghij", ready: false, endpoint: null });
    });
    it("reads the pooler once the project is healthy, and builds the URL itself", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(json({ ref: "abcdefghij", status: "ACTIVE_HEALTHY" }))
            .mockResolvedValueOnce(
                json([
                    {
                        database_type: "PRIMARY",
                        db_user: "postgres.abcdefghij",
                        db_host: "aws-0-us-east-1.pooler.supabase.com",
                        db_port: 6543,
                        db_name: "postgres"
                    }
                ])
            );
        const instance = await supabase.get(fetch, cloud, "abcdefghij");
        expect(fetch.mock.calls[1]![0]).toBe(
            `${SUPABASE_API}/projects/abcdefghij/config/database/pooler`
        );
        expect(instance.ready).toBe(true);
        expect(instance.endpoint).toMatchObject({
            host: "aws-0-us-east-1.pooler.supabase.com",
            port: 6543,
            username: "postgres.abcdefghij",
            password: "p@ss",
            database: "postgres"
        });
    });
    it("says what Supabase answered when it refuses", async () => {
        const error = await refusal(
            supabase.create(
                vi.fn().mockResolvedValueOnce(json({ message: "Organization not found" }, 400)),
                cloud
            )
        );
        expect(error.params.message).toBe("Organization not found");
    });
});

describe("Upstash", () => {
    const cloud = { ...CLOUD, region: "us-east-1", account: "me@example.com" };
    const ready = {
        database_id: "db-9",
        database_name: "db-ab12cd34",
        endpoint: "fine-cat-1.upstash.io",
        port: 6379,
        password: "pw/1",
        state: "active",
        tls: true
    };

    it("creates with basic auth, after making sure it does not exist yet", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(json([])).mockResolvedValueOnce(json(ready));
        const instance = await upstash.create(fetch, cloud);
        expect(fetch.mock.calls[0]![0]).toBe(`${UPSTASH_API}/databases`);
        expect(fetch.mock.calls[1]![0]).toBe(`${UPSTASH_API}/database`);
        expect(headerOf(fetch, 1).authorization).toBe(
            `Basic ${Buffer.from("me@example.com:key-123").toString("base64")}`
        );
        expect(bodyOf(fetch, 1)).toEqual({
            database_name: "db-ab12cd34",
            platform: "aws",
            primary_region: "us-east-1",
            tls: true
        });
        expect(instance.ready).toBe(true);
        expect(instance.endpoint?.url).toBe("rediss://:pw%2F1@fine-cat-1.upstash.io:6379");
    });
    it("adopts the database its name already made instead of a second one", async () => {
        const fetch = vi.fn().mockResolvedValueOnce(json([ready]));
        const instance = await upstash.create(fetch, cloud);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(instance.id).toBe("db-9");
    });
    it("tells AWS regions from GCP ones", () => {
        expect(upstashPlatform("eu-west-1")).toBe("aws");
        expect(upstashPlatform("us-central1")).toBe("gcp");
    });
    it("finds by name and deletes by id", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(json([ready]))
            .mockResolvedValueOnce(json("OK"));
        const id = await upstash.find(fetch, cloud);
        await upstash.remove(fetch, cloud, id!);
        expect(fetch.mock.calls[1]![0]).toBe(`${UPSTASH_API}/database/db-9`);
        expect(fetch.mock.calls[1]![1].method).toBe("DELETE");
    });
});

describe("a provider's words", () => {
    it("takes the message out of a JSON body and never echoes markup", () => {
        expect(providerMessage(JSON.stringify({ error: "quota reached" }))).toBe("quota reached");
        expect(providerMessage("<html><body>502</body></html>")).toBe("");
        expect(providerMessage("x".repeat(500))).toHaveLength(300);
    });
});

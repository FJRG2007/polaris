/**
 * The data engines of the "new database" flow: what each runs as on a server,
 * what it answers to in a reference wherever it lives, how a cloud connection is
 * checked before it is stored, and CloudAMQP's documented request shapes.
 */

import * as core from "@polaris/core";
import { dbComposeSpec } from "@polaris/deploy";
import { describe, expect, it, vi } from "vitest";
import * as cloudamqp from "@/lib/data-cloud/cloudamqp";

const creds = { username: "admin", password: "s3cret/pw", database: "files", token: "tok" };

describe("self-hosted containers", () => {
    it.each(core.DATA_ENGINES)("%s pins an official image and checks its own health", (engine) => {
        const info = core.DATA_ENGINE_INFO[engine];
        const image = info.image(info.versions[0]!);
        expect(image).not.toMatch(/:latest$/);
        const container = core.dataEngineContainer(engine, creds, "db-host");
        expect(container.healthcheck.test[0]).toBe("CMD");
        expect(core.MANAGED_ENGINES).toContain(engine);
        expect(core.databaseDataPath(engine, info.versions[0]!)).toBe(info.dataPath);
    });

    it("runs Kafka in KRaft, advertising the container's own name", () => {
        const env = core.dataEngineContainer("kafka", creds, "events").env;
        expect(env.KAFKA_PROCESS_ROLES).toBe("broker,controller");
        expect(env.KAFKA_ADVERTISED_LISTENERS).toBe("PLAINTEXT://events:9092");
        expect(Object.keys(env).some((key) => key.includes("ZOOKEEPER"))).toBe(false);
    });

    it("hands the healthcheck and the engine's port to the compose spec", () => {
        const container = core.dataEngineContainer("meilisearch", creds, "search");
        const spec = dbComposeSpec(
            {
                ref: { project: "p", name: "search" },
                image: "getmeili/meilisearch:v1.12",
                env: container.env,
                volumeName: "search-data",
                dataPath: "/meili_data",
                exposePort: 17700,
                containerPort: 7700,
                healthcheck: container.healthcheck
            } as Parameters<typeof dbComposeSpec>[0],
            "polaris"
        );
        const service = spec.services[0]!;
        expect(service.ports).toEqual([{ host: 17700, container: 7700 }]);
        expect(service.healthcheck?.test).toEqual([
            "CMD",
            "curl",
            "-fs",
            "http://127.0.0.1:7700/health"
        ]);
    });
});

describe("reference keys", () => {
    it("names MinIO the way S3 clients read it", () => {
        const keys = core.dataEngineReferenceKeys(
            "minio",
            core.selfHostedEndpoint("minio", "files", creds)
        );
        expect(keys).toMatchObject({
            S3_ENDPOINT: "http://files:9000",
            S3_ACCESS_KEY_ID: "admin",
            S3_SECRET_ACCESS_KEY: "s3cret/pw",
            S3_BUCKET: "files",
            AWS_REGION: "us-east-1"
        });
    });

    it("escapes credentials in a URL", () => {
        const keys = core.dataEngineReferenceKeys(
            "rabbitmq",
            core.selfHostedEndpoint("rabbitmq", "mq", creds)
        );
        expect(keys.AMQP_URL).toBe("amqp://admin:s3cret%2Fpw@mq:5672");
        expect(keys.RABBITMQ_MANAGEMENT_URL).toBe("http://mq:15672");
    });

    it("answers the same keys from a cloud as from a server", () => {
        const self = core.dataEngineReferenceKeys(
            "meilisearch",
            core.selfHostedEndpoint("meilisearch", "s", creds)
        );
        const input = core.cloudConnectSchema.parse({
            environmentId: "00000000-0000-4000-8000-000000000001",
            name: "search",
            engine: "meilisearch",
            provider: "meilisearch-cloud",
            url: " https://MS-1.meilisearch.io/ ",
            token: "key"
        });
        const cloud = core.dataEngineReferenceKeys("meilisearch", core.cloudEndpoint(input));
        expect(Object.keys(cloud).sort()).toEqual(Object.keys(self).sort());
        expect(cloud.MEILI_HOST).toBe("https://ms-1.meilisearch.io");
    });

    it("reaches the generic database keys too", () => {
        const endpoint = core.selfHostedEndpoint("typesense", "ts", creds);
        const keys = core.databaseReferenceKeys({
            engine: "typesense",
            host: "ts",
            port: 8108,
            database: "",
            username: "",
            password: "s3cret/pw",
            uri: endpoint.url,
            endpoint
        });
        expect(keys.TYPESENSE_API_KEY).toBe("s3cret/pw");
    });
});

describe("connecting an existing instance", () => {
    const base = { environmentId: "00000000-0000-4000-8000-000000000001", name: "x" };

    it("refuses a provider that does not offer the engine", () => {
        const result = core.cloudConnectSchema.safeParse({
            ...base,
            engine: "kafka",
            provider: "cloudflare-r2",
            url: "broker:9092"
        });
        expect(result.success).toBe(false);
    });

    it("normalizes a broker list and refuses a malformed one", () => {
        const ok = core.cloudConnectSchema.parse({
            ...base,
            engine: "kafka",
            provider: "confluent-cloud",
            url: " PKC-1.eu-west-1.aws.confluent.cloud:9092 , b2.example.com:9092 "
        });
        expect(ok.url).toBe("pkc-1.eu-west-1.aws.confluent.cloud:9092,b2.example.com:9092");
        expect(
            core.cloudConnectSchema.safeParse({
                ...base,
                engine: "kafka",
                provider: "confluent-cloud",
                url: "http://x"
            }).success
        ).toBe(false);
    });

    it("requires each engine's own fields, and keeps credentials out of an http address", () => {
        expect(
            core.cloudConnectSchema.safeParse({
                ...base,
                engine: "influxdb",
                provider: "influxdb-cloud",
                url: "https://a.b"
            }).success
        ).toBe(false);
        expect(
            core.cloudConnectSchema.safeParse({
                ...base,
                engine: "couchdb",
                provider: "cloudant",
                url: "https://u:p@acct.cloudant.com",
                username: "u",
                password: "p"
            }).success
        ).toBe(false);
    });

    it("gives every issue as a key the form translates", () => {
        const result = core.cloudConnectSchema.safeParse({
            ...base,
            engine: "couchdb",
            provider: "other",
            url: "ftp://a.b"
        });
        expect(result.success).toBe(false);
        for (const issue of result.success ? [] : result.error.issues) {
            expect(issue.message).toMatch(/^view\.database\.cloud\.issues\.[A-Za-z]+$/);
        }
    });

    it("reaches Kafka at another provider over TLS unless told it is plaintext", () => {
        const kafka = (provider: string, extra: Record<string, unknown>) =>
            core.cloudEndpoint(
                core.cloudConnectSchema.parse({
                    ...base,
                    engine: "kafka",
                    provider,
                    url: "broker.example.com:9092",
                    ...extra
                })
            ).securityProtocol;
        expect(kafka("other", {})).toBe("SSL");
        expect(kafka("other", { tls: false })).toBe("PLAINTEXT");
        expect(kafka("other", { tls: false, username: "u", password: "p" })).toBe("SASL_PLAINTEXT");
        // A listed provider requires TLS whatever the form sent.
        expect(kafka("confluent-cloud", { tls: false, username: "u", password: "p" })).toBe(
            "SASL_SSL"
        );
    });

    it("checks a plaintext Kafka broker without TLS", async () => {
        const { testCloudConnection } = await import("@/lib/data-cloud/service");
        const openSocket = vi.fn(async (_host: string, _port: number, _tls: boolean) => undefined);
        const input = core.cloudConnectSchema.parse({
            ...base,
            engine: "kafka",
            provider: "other",
            url: "broker.example.com:9092",
            tls: false
        });
        await testCloudConnection(input, vi.fn(), openSocket);
        expect(openSocket).toHaveBeenCalledWith("broker.example.com", 9092, false);
    });

    it("refuses an address that resolves to a private network", async () => {
        const { testCloudConnection } = await import("@/lib/data-cloud/service");
        const input = core.cloudConnectSchema.parse({
            ...base,
            engine: "typesense",
            provider: "other",
            url: "http://127.0.0.1:8108",
            token: "k"
        });
        await expect(testCloudConnection(input)).rejects.toMatchObject({ key: "privateAddress" });
    });

    it("tests the key against the engine's own API", async () => {
        const { testCloudConnection } = await import("@/lib/data-cloud/service");
        const request = vi.fn(async () => new Response("{}", { status: 403 }));
        const input = core.cloudConnectSchema.parse({
            ...base,
            engine: "typesense",
            provider: "typesense-cloud",
            url: "https://xyz.a1.typesense.net",
            token: "k"
        });
        await expect(testCloudConnection(input, request)).rejects.toMatchObject({
            key: "keyRefused"
        });
        expect(request).toHaveBeenCalledWith("https://xyz.a1.typesense.net/collections", {
            headers: { "x-typesense-api-key": "k" }
        });
    });
});

describe("CloudAMQP", () => {
    const basic = `Basic ${Buffer.from(":key-123").toString("base64")}`;

    it("creates with name, plan, region and tags under basic auth with the key as password", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(new Response("[]", { status: 200 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ id: 42, url: "", ready: false }), { status: 200 })
            );
        const created = await cloudamqp.createCloudAmqpInstance(request, "key-123", {
            name: "queue",
            plan: "lemur",
            region: "amazon-web-services::us-east-1"
        });
        expect(created).toEqual({ id: "42", name: "", url: "", ready: false });
        const [url, init] = request.mock.calls[1]!;
        expect(url).toBe("https://customer.cloudamqp.com/api/instances");
        expect(init.method).toBe("POST");
        expect(init.headers.authorization).toBe(basic);
        expect(JSON.parse(init.body)).toEqual({
            name: "queue",
            plan: "lemur",
            region: "amazon-web-services::us-east-1",
            tags: ["polaris"]
        });
    });

    it("does not create a second instance with the same name", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify([{ id: 7, name: "queue", ready: true, url: "amqps://a" }])
                )
            );
        const found = await cloudamqp.createCloudAmqpInstance(request, "key-123", {
            name: "queue",
            plan: "lemur",
            region: "amazon-web-services::us-east-1"
        });
        expect(found.id).toBe("7");
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("deletes by id and treats an instance already gone as deleted", async () => {
        const request = vi.fn(async () => new Response("", { status: 404 }));
        await cloudamqp.deleteCloudAmqpInstance(request, "key-123", "42");
        expect(request).toHaveBeenCalledWith("https://customer.cloudamqp.com/api/instances/42", {
            method: "DELETE",
            headers: { authorization: basic }
        });
    });

    it("says the key was refused without echoing it", async () => {
        const request = vi.fn(async () => new Response("", { status: 401 }));
        await expect(cloudamqp.getCloudAmqpInstance(request, "key-123", "1")).rejects.toMatchObject(
            {
                key: "amqpKeyRefused"
            }
        );
    });
});

describe("one-click templates", () => {
    it("no longer offers the engines that moved to databases", () => {
        const ids = core.SERVICE_TEMPLATES.map((template) => template.id);
        for (const retired of core.RETIRED_TEMPLATE_IDS) expect(ids).not.toContain(retired);
    });

    it("still knows MinIO's setup for a service an earlier release made from it", () => {
        expect(core.serviceTemplate("minio")).toBeNull();
        expect(core.serviceTemplateOfService("minio")?.prepare?.length).toBe(1);
        expect(core.serviceTemplateOfService("kafka")).toBeNull();
        expect(core.serviceTemplateOfService(undefined)).toBeNull();
    });
});

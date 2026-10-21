/**
 * Data engines beyond the SQL and key-value ones: object storage, search,
 * analytics, time series, documents and messaging. They are created from the
 * same "new database" flow as PostgreSQL or Redis and share its machinery - a
 * container with one data volume, generated credentials held encrypted, the
 * deploy queue, the canvas, `${{name.KEY}}` references - but nothing that reads
 * data out of a database: the data browser and the saved connections are typed
 * by `DbEngine`, which these are not members of.
 *
 * Each one can live in one of two places:
 *
 * - On a server, run by Polaris from a pinned official image.
 * - In a cloud, either one the user already has (they paste its endpoint and
 *   credentials) or, where the provider documents a provisioning API usable with
 *   the user's own key, one Polaris creates for them.
 *
 * Wherever it lives, it answers to the same reference keys (`dataEngineReferenceKeys`),
 * so a service does not care which.
 */

import { z } from "zod";

export const DATA_ENGINES = [
    "minio",
    "meilisearch",
    "typesense",
    "clickhouse",
    "influxdb",
    "couchdb",
    "kafka",
    "rabbitmq"
] as const;
export type DataEngine = (typeof DATA_ENGINES)[number];

/** True for one of the engines this module describes. */
export function isDataEngine(engine: unknown): engine is DataEngine {
    return typeof engine === "string" && (DATA_ENGINES as readonly string[]).includes(engine);
}

/** How the new-database picker groups every engine it offers. */
export const ENGINE_GROUPS = [
    "relational",
    "keyValue",
    "document",
    "search",
    "analytics",
    "objectStorage",
    "messaging"
] as const;
export type EngineGroup = (typeof ENGINE_GROUPS)[number];

/** The group of any engine the flow creates. Unknown engines read as relational. */
export function engineGroup(engine: string): EngineGroup {
    switch (engine) {
        case "redis":
            return "keyValue";
        case "mongo":
        case "couchdb":
            return "document";
        case "meilisearch":
        case "typesense":
            return "search";
        case "clickhouse":
        case "influxdb":
            return "analytics";
        case "seaweedfs":
        case "minio":
            return "objectStorage";
        case "kafka":
        case "rabbitmq":
            return "messaging";
        default:
            return "relational";
    }
}

export interface DataEngineInfo {
    readonly id: DataEngine;
    readonly label: string;
    /** The port clients connect to inside the container. */
    readonly port: number;
    /** Offered versions, newest first; each one is a pinned image tag. */
    readonly versions: readonly string[];
    readonly dataPath: string;
    image(version: string): string;
}

export const DATA_ENGINE_INFO: Readonly<Record<DataEngine, DataEngineInfo>> = {
    minio: {
        id: "minio",
        label: "MinIO",
        port: 9000,
        // MinIO stopped publishing community images in October 2025, so the last
        // published release is pinned rather than `latest`, which no longer moves.
        versions: ["2025-04-22T22-12-26Z"],
        dataPath: "/data",
        image: (version) => `minio/minio:RELEASE.${version}`
    },
    meilisearch: {
        id: "meilisearch",
        label: "Meilisearch",
        port: 7700,
        versions: ["1.12"],
        dataPath: "/meili_data",
        image: (version) => `getmeili/meilisearch:v${version}`
    },
    typesense: {
        id: "typesense",
        label: "Typesense",
        port: 8108,
        versions: ["30.1"],
        dataPath: "/data",
        image: (version) => `typesense/typesense:${version}`
    },
    clickhouse: {
        id: "clickhouse",
        label: "ClickHouse",
        port: 8123,
        versions: ["25.8"],
        dataPath: "/var/lib/clickhouse",
        image: (version) => `clickhouse/clickhouse-server:${version}-alpine`
    },
    influxdb: {
        id: "influxdb",
        label: "InfluxDB",
        port: 8086,
        versions: ["2.7"],
        dataPath: "/var/lib/influxdb2",
        image: (version) => `influxdb:${version}`
    },
    couchdb: {
        id: "couchdb",
        label: "CouchDB",
        port: 5984,
        versions: ["3.5.3"],
        dataPath: "/opt/couchdb/data",
        image: (version) => `couchdb:${version}`
    },
    kafka: {
        id: "kafka",
        label: "Apache Kafka",
        port: 9092,
        versions: ["4.0.0"],
        dataPath: "/var/lib/kafka/data",
        image: (version) => `apache/kafka:${version}`
    },
    rabbitmq: {
        id: "rabbitmq",
        label: "RabbitMQ",
        port: 5672,
        versions: ["4.3"],
        dataPath: "/var/lib/rabbitmq",
        image: (version) => `rabbitmq:${version}-management-alpine`
    }
};

/** The InfluxDB organization a self-hosted instance is set up with. */
export const INFLUX_ORG = "polaris";
/** The region an S3 client is told for a self-hosted MinIO. */
const MINIO_REGION = "us-east-1";

/** What a self-hosted data engine is started with, beyond its image. */
export interface DataEngineCredentials {
    /** The admin user, or the S3 access key for MinIO. Empty where the engine
     *  has no user (Meilisearch, Typesense, Kafka). */
    readonly username: string;
    /** The admin password, the S3 secret, or the API / master key. */
    readonly password: string;
    /** The bucket, database or vhost created at start; empty where none is. */
    readonly database: string;
    /** InfluxDB's admin API token. */
    readonly token?: string;
}

export interface DataEngineHealthcheck {
    readonly test: readonly string[];
    readonly intervalSeconds: number;
    readonly retries: number;
    readonly startPeriodSeconds: number;
}

export interface DataEngineContainer {
    readonly env: Record<string, string>;
    readonly command?: string[];
    readonly healthcheck: DataEngineHealthcheck;
}

const health = (test: string[], startPeriodSeconds = 20): DataEngineHealthcheck => ({
    test,
    intervalSeconds: 15,
    retries: 5,
    startPeriodSeconds
});

/**
 * The container a self-hosted engine runs as. `host` is the container's own name
 * on the proxy network, which Kafka has to advertise to its clients.
 *
 * Each healthcheck uses a tool the image ships: MinIO's `mc`, curl in the
 * Meilisearch and CouchDB images, busybox wget in ClickHouse's Alpine one,
 * bash in Typesense's, and the engines' own CLIs for InfluxDB, Kafka and
 * RabbitMQ.
 */
export function dataEngineContainer(
    engine: DataEngine,
    creds: DataEngineCredentials,
    host: string
): DataEngineContainer {
    switch (engine) {
        case "minio":
            return {
                env: {
                    MINIO_ROOT_USER: creds.username,
                    MINIO_ROOT_PASSWORD: creds.password,
                    // The alias `mc` reads for the healthcheck and the first bucket.
                    MC_HOST_local: `http://${creds.username}:${creds.password}@127.0.0.1:9000`
                },
                // Unwrapped: the image's entrypoint prepends `minio`.
                command: ["server", "/data", "--console-address", ":9001"],
                healthcheck: health(["CMD", "mc", "ready", "local"])
            };
        case "meilisearch":
            return {
                env: {
                    MEILI_ENV: "production",
                    MEILI_NO_ANALYTICS: "true",
                    MEILI_MASTER_KEY: creds.password
                },
                healthcheck: health(["CMD", "curl", "-fs", "http://127.0.0.1:7700/health"])
            };
        case "typesense":
            return {
                env: { TYPESENSE_API_KEY: creds.password },
                command: ["--data-dir", "/data", "--enable-cors"],
                healthcheck: health(["CMD", "bash", "-c", ":> /dev/tcp/127.0.0.1/8108"])
            };
        case "clickhouse":
            return {
                env: {
                    CLICKHOUSE_USER: creds.username,
                    CLICKHOUSE_PASSWORD: creds.password,
                    CLICKHOUSE_DB: creds.database,
                    CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1"
                },
                healthcheck: health(["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8123/ping"])
            };
        case "influxdb":
            return {
                env: {
                    DOCKER_INFLUXDB_INIT_MODE: "setup",
                    DOCKER_INFLUXDB_INIT_USERNAME: creds.username,
                    DOCKER_INFLUXDB_INIT_PASSWORD: creds.password,
                    DOCKER_INFLUXDB_INIT_ORG: INFLUX_ORG,
                    DOCKER_INFLUXDB_INIT_BUCKET: creds.database,
                    DOCKER_INFLUXDB_INIT_ADMIN_TOKEN: creds.token ?? ""
                },
                healthcheck: health(["CMD", "influx", "ping"])
            };
        case "couchdb":
            return {
                env: { COUCHDB_USER: creds.username, COUCHDB_PASSWORD: creds.password },
                healthcheck: health(["CMD", "curl", "-fs", "http://127.0.0.1:5984/_up"])
            };
        case "kafka":
            // KRaft, one node that is both broker and controller; no ZooKeeper.
            return {
                env: {
                    KAFKA_NODE_ID: "1",
                    KAFKA_PROCESS_ROLES: "broker,controller",
                    KAFKA_LISTENERS: "PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093",
                    KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${host}:9092`,
                    KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
                    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
                    KAFKA_INTER_BROKER_LISTENER_NAME: "PLAINTEXT",
                    KAFKA_CONTROLLER_QUORUM_VOTERS: "1@localhost:9093",
                    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
                    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
                    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
                    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: "0",
                    KAFKA_NUM_PARTITIONS: "3",
                    KAFKA_LOG_DIRS: "/var/lib/kafka/data"
                },
                healthcheck: health(
                    [
                        "CMD",
                        "/opt/kafka/bin/kafka-broker-api-versions.sh",
                        "--bootstrap-server",
                        "localhost:9092"
                    ],
                    60
                )
            };
        case "rabbitmq":
            return {
                env: {
                    RABBITMQ_DEFAULT_USER: creds.username,
                    RABBITMQ_DEFAULT_PASS: creds.password,
                    // The data folder is named after the node, which is named after
                    // the host; a container's host name changes when it is
                    // recreated, so the node is given one that does not.
                    RABBITMQ_NODENAME: "rabbit@localhost"
                },
                healthcheck: health(["CMD", "rabbitmq-diagnostics", "-q", "ping"], 30)
            };
    }
}

/**
 * Everything a client needs to reach a data engine, wherever it runs. Each field
 * is empty where the engine has nothing to put in it.
 */
export interface DataEndpoint {
    /** The address a client library takes as-is. */
    readonly url: string;
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: string;
    /** The bucket (MinIO, InfluxDB), database (ClickHouse) or vhost (RabbitMQ). */
    readonly database: string;
    /** An API key, master key or token. */
    readonly token: string;
    readonly org: string;
    readonly region: string;
    /** A second address: the MinIO console, the RabbitMQ management API. */
    readonly managementUrl: string;
    /** ClickHouse's native-protocol URL. */
    readonly nativeUrl: string;
    /** Kafka: the bootstrap servers as `host:port,...`. */
    readonly brokers: string;
    /** Kafka: the SASL mechanism, when it authenticates. */
    readonly saslMechanism: string;
    /** Kafka: `PLAINTEXT`, `SSL` or `SASL_SSL`. */
    readonly securityProtocol: string;
}

const EMPTY_ENDPOINT: DataEndpoint = {
    url: "",
    host: "",
    port: 0,
    username: "",
    password: "",
    database: "",
    token: "",
    org: "",
    region: "",
    managementUrl: "",
    nativeUrl: "",
    brokers: "",
    saslMechanism: "",
    securityProtocol: ""
};

/** An endpoint with nothing in it yet: a cloud instance still being created. */
export function cloudEndpointPlaceholder(): DataEndpoint {
    return { ...EMPTY_ENDPOINT };
}

/** How a self-hosted engine is reached at `host` on the proxy network. */
export function selfHostedEndpoint(
    engine: DataEngine,
    host: string,
    creds: DataEngineCredentials
): DataEndpoint {
    const port = DATA_ENGINE_INFO[engine].port;
    const user = encodeURIComponent(creds.username);
    const secret = encodeURIComponent(creds.password);
    const base = {
        ...EMPTY_ENDPOINT,
        host,
        port,
        username: creds.username,
        password: creds.password,
        database: creds.database
    };
    switch (engine) {
        case "minio":
            return {
                ...base,
                url: `http://${host}:9000`,
                region: MINIO_REGION,
                managementUrl: `http://${host}:9001`
            };
        case "meilisearch":
        case "typesense":
            return { ...base, url: `http://${host}:${port}`, token: creds.password };
        case "clickhouse":
            return {
                ...base,
                url: `http://${host}:8123`,
                nativeUrl: `clickhouse://${user}:${secret}@${host}:9000/${creds.database}`
            };
        case "influxdb":
            return { ...base, url: `http://${host}:8086`, token: creds.token ?? "", org: INFLUX_ORG };
        case "couchdb":
            return { ...base, url: `http://${user}:${secret}@${host}:5984` };
        case "kafka":
            return {
                ...base,
                url: `${host}:9092`,
                brokers: `${host}:9092`,
                securityProtocol: "PLAINTEXT"
            };
        case "rabbitmq":
            return {
                ...base,
                url: `amqp://${user}:${secret}@${host}:5672`,
                database: "/",
                managementUrl: `http://${host}:15672`
            };
    }
}

/** Only the keys with something in them. */
function present(keys: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(keys).filter(([, value]) => value !== ""));
}

/**
 * The keys a data engine answers to in a reference (`${{search.MEILI_HOST}}`),
 * beside the generic ones every database has: the names each engine's own
 * clients and documentation read, so an application needs nothing renamed.
 */
export function dataEngineReferenceKeys(
    engine: DataEngine,
    endpoint: DataEndpoint
): Record<string, string> {
    const e = endpoint;
    switch (engine) {
        case "minio":
            return present({
                S3_ENDPOINT: e.url,
                S3_ACCESS_KEY_ID: e.username,
                S3_SECRET_ACCESS_KEY: e.password,
                S3_REGION: e.region,
                S3_BUCKET: e.database,
                S3_FORCE_PATH_STYLE: "true",
                AWS_ENDPOINT_URL_S3: e.url,
                AWS_ACCESS_KEY_ID: e.username,
                AWS_SECRET_ACCESS_KEY: e.password,
                AWS_REGION: e.region,
                BUCKET: e.database,
                MINIO_ENDPOINT: e.url,
                MINIO_ACCESS_KEY: e.username,
                MINIO_SECRET_KEY: e.password,
                MINIO_CONSOLE_URL: e.managementUrl
            });
        case "meilisearch":
            return present({
                MEILI_HOST: e.url,
                MEILISEARCH_HOST: e.url,
                MEILISEARCH_URL: e.url,
                MEILI_MASTER_KEY: e.token,
                MEILISEARCH_API_KEY: e.token,
                API_KEY: e.token
            });
        case "typesense": {
            const protocol = e.url.startsWith("https:") ? "https" : "http";
            return present({
                TYPESENSE_URL: e.url,
                TYPESENSE_HOST: e.host,
                TYPESENSE_PORT: e.port ? String(e.port) : "",
                TYPESENSE_PROTOCOL: protocol,
                TYPESENSE_API_KEY: e.token,
                API_KEY: e.token
            });
        }
        case "clickhouse":
            return present({
                CLICKHOUSE_URL: e.url,
                CLICKHOUSE_HTTP_URL: e.url,
                CLICKHOUSE_NATIVE_URL: e.nativeUrl,
                CLICKHOUSE_USER: e.username,
                CLICKHOUSE_PASSWORD: e.password,
                CLICKHOUSE_DB: e.database,
                CLICKHOUSE_DATABASE: e.database
            });
        case "influxdb":
            return present({
                INFLUX_URL: e.url,
                INFLUX_TOKEN: e.token,
                INFLUX_ORG: e.org,
                INFLUX_BUCKET: e.database,
                INFLUXDB_URL: e.url,
                INFLUXDB_TOKEN: e.token,
                INFLUXDB_ORG: e.org,
                INFLUXDB_BUCKET: e.database
            });
        case "couchdb":
            return present({
                COUCHDB_URL: e.url,
                COUCH_URL: e.url,
                COUCHDB_USER: e.username,
                COUCHDB_PASSWORD: e.password
            });
        case "kafka":
            return present({
                KAFKA_BROKERS: e.brokers,
                KAFKA_BOOTSTRAP_SERVERS: e.brokers,
                BOOTSTRAP_SERVERS: e.brokers,
                KAFKA_SECURITY_PROTOCOL: e.securityProtocol,
                KAFKA_SASL_MECHANISM: e.saslMechanism,
                KAFKA_SASL_USERNAME: e.username,
                KAFKA_SASL_PASSWORD: e.password
            });
        case "rabbitmq":
            return present({
                AMQP_URL: e.url,
                RABBITMQ_URL: e.url,
                RABBITMQ_MANAGEMENT_URL: e.managementUrl,
                RABBITMQ_USER: e.username,
                RABBITMQ_PASSWORD: e.password,
                RABBITMQ_VHOST: e.database
            });
    }
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

/**
 * Where an engine can live outside a server of yours. `create` is offered only
 * for a provider whose provisioning API is documented and usable with the
 * user's own key; every other one is connected to after it is created there.
 */
export interface DataCloudProvider {
    readonly id: string;
    readonly label: string;
    readonly engines: readonly DataEngine[];
    /** Where to create one by hand. */
    readonly consoleUrl: string;
    readonly create: boolean;
}

export const DATA_CLOUD_PROVIDERS: readonly DataCloudProvider[] = [
    { id: "aws-s3", label: "Amazon S3", engines: ["minio"], consoleUrl: "https://console.aws.amazon.com/s3/", create: false },
    { id: "cloudflare-r2", label: "Cloudflare R2", engines: ["minio"], consoleUrl: "https://dash.cloudflare.com/?to=/:account/r2", create: false },
    { id: "backblaze-b2", label: "Backblaze B2", engines: ["minio"], consoleUrl: "https://secure.backblaze.com/b2_buckets.htm", create: false },
    { id: "meilisearch-cloud", label: "Meilisearch Cloud", engines: ["meilisearch"], consoleUrl: "https://cloud.meilisearch.com", create: false },
    { id: "typesense-cloud", label: "Typesense Cloud", engines: ["typesense"], consoleUrl: "https://cloud.typesense.org", create: false },
    { id: "clickhouse-cloud", label: "ClickHouse Cloud", engines: ["clickhouse"], consoleUrl: "https://console.clickhouse.cloud", create: false },
    { id: "influxdb-cloud", label: "InfluxDB Cloud", engines: ["influxdb"], consoleUrl: "https://cloud2.influxdata.com", create: false },
    { id: "cloudant", label: "IBM Cloudant", engines: ["couchdb"], consoleUrl: "https://cloud.ibm.com/catalog/services/cloudant", create: false },
    { id: "confluent-cloud", label: "Confluent Cloud", engines: ["kafka"], consoleUrl: "https://confluent.cloud", create: false },
    { id: "aiven", label: "Aiven", engines: ["kafka", "clickhouse"], consoleUrl: "https://console.aiven.io", create: false },
    // https://docs.cloudamqp.com/cloudamqp_api.html - POST /api/instances with the
    // account's API key; see `lib/data-cloud/cloudamqp.ts`.
    { id: "cloudamqp", label: "CloudAMQP", engines: ["rabbitmq"], consoleUrl: "https://customer.cloudamqp.com", create: true },
    { id: "other", label: "Another provider", engines: [...DATA_ENGINES], consoleUrl: "", create: false }
];

/** The providers an engine can be placed with. */
export function cloudProvidersFor(engine: string): readonly DataCloudProvider[] {
    return DATA_CLOUD_PROVIDERS.filter((provider) =>
        (provider.engines as readonly string[]).includes(engine)
    );
}

/** One field the connect form asks for. */
export type CloudField =
    | "url"
    | "username"
    | "password"
    | "token"
    | "database"
    | "org"
    | "region"
    | "managementUrl"
    | "saslMechanism";

/** What connecting to each engine takes, and which of it is required. */
export const CLOUD_FIELDS: Readonly<
    Record<DataEngine, readonly { readonly field: CloudField; readonly required: boolean }[]>
> = {
    minio: [
        { field: "url", required: true },
        { field: "region", required: true },
        { field: "username", required: true },
        { field: "password", required: true },
        { field: "database", required: true }
    ],
    meilisearch: [
        { field: "url", required: true },
        { field: "token", required: true }
    ],
    typesense: [
        { field: "url", required: true },
        { field: "token", required: true }
    ],
    clickhouse: [
        { field: "url", required: true },
        { field: "username", required: true },
        { field: "password", required: true },
        { field: "database", required: false }
    ],
    influxdb: [
        { field: "url", required: true },
        { field: "token", required: true },
        { field: "org", required: true },
        { field: "database", required: true }
    ],
    couchdb: [
        { field: "url", required: true },
        { field: "username", required: true },
        { field: "password", required: true }
    ],
    kafka: [
        { field: "url", required: true },
        { field: "saslMechanism", required: false },
        { field: "username", required: false },
        { field: "password", required: false }
    ],
    rabbitmq: [
        { field: "url", required: true },
        { field: "managementUrl", required: false }
    ]
};

export const KAFKA_SASL_MECHANISMS = ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"] as const;

/**
 * The words of every issue below, as keys of the `deploy` catalog: the form and
 * the action translate them where they are shown.
 */
const ISSUE = "view.database.cloud.issues";

/** The schemes each engine's address may use. Kafka's is a broker list instead. */
const URL_SCHEMES: Readonly<Record<Exclude<DataEngine, "kafka">, readonly string[]>> = {
    minio: ["https:", "http:"],
    meilisearch: ["https:", "http:"],
    typesense: ["https:", "http:"],
    clickhouse: ["https:", "http:"],
    influxdb: ["https:", "http:"],
    couchdb: ["https:", "http:"],
    rabbitmq: ["amqps:", "amqp:"]
};

const text = (max: number) => z.string().trim().max(max, `${ISSUE}.tooLong`).default("");

/** `HOST:PORT` for one broker: a DNS name or IPv4 address and a port. */
const BROKER = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?:\d{1,5}$/;

/** A broker list as one canonical string: lower-cased, no spaces, no empties. */
export function normalizeBrokers(value: string): string {
    return value
        .split(/[\s,]+/)
        .map((one) => one.trim().toLowerCase())
        .filter(Boolean)
        .join(",");
}

/**
 * An address as it is stored: scheme and host lower-cased by the URL parser, no
 * trailing slash. Null when it is not a URL at all.
 */
export function normalizeEndpointUrl(value: string): URL | null {
    try {
        const url = new URL(value.trim());
        url.hash = "";
        return url;
    } catch {
        return null;
    }
}

function urlText(url: URL): string {
    return url.toString().replace(/\/+$/, "");
}

/**
 * Connecting to an engine that already exists somewhere else. One schema, run by
 * the form as it is typed and by the action before anything is stored; every
 * field is trimmed, and addresses are canonicalized in the transform, after
 * they have been checked.
 */
export const cloudConnectSchema = z
    .object({
        environmentId: z.string().uuid(),
        name: z.string().trim().min(1, `${ISSUE}.nameRequired`).max(64, `${ISSUE}.tooLong`),
        engine: z.enum(DATA_ENGINES),
        provider: z
            .string()
            .trim()
            .refine((id) => DATA_CLOUD_PROVIDERS.some((one) => one.id === id), `${ISSUE}.provider`),
        url: text(2048),
        username: text(256),
        password: z.string().max(1024, `${ISSUE}.tooLong`).default(""),
        token: z.string().trim().max(4096, `${ISSUE}.tooLong`).default(""),
        database: text(256),
        org: text(256),
        region: text(64),
        managementUrl: text(2048),
        saslMechanism: z.enum(["", ...KAFKA_SASL_MECHANISMS]).default(""),
        /** Kafka at another provider only: whether its brokers speak TLS. Every
         *  listed provider requires it. */
        tls: z.boolean().default(true)
    })
    .superRefine((value, ctx) => {
        const issue = (path: CloudField | "provider", message: string) =>
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
        if (!cloudProvidersFor(value.engine).some((one) => one.id === value.provider)) {
            issue("provider", `${ISSUE}.providerEngine`);
        }
        for (const { field, required } of CLOUD_FIELDS[value.engine]) {
            if (required && !value[field]) issue(field, `${ISSUE}.required`);
        }
        if (value.engine === "kafka") {
            const brokers = normalizeBrokers(value.url);
            if (brokers && !brokers.split(",").every((one) => BROKER.test(one))) {
                issue("url", `${ISSUE}.brokers`);
            }
            if (Boolean(value.username) !== Boolean(value.password)) {
                issue(value.username ? "password" : "username", `${ISSUE}.saslPair`);
            }
            return;
        }
        if (value.url) {
            const url = normalizeEndpointUrl(value.url);
            const schemes = URL_SCHEMES[value.engine];
            if (!url || !schemes.includes(url.protocol)) {
                issue("url", `${ISSUE}.${value.engine === "rabbitmq" ? "urlAmqp" : "urlHttp"}`);
            } else if ((url.username || url.password) && value.engine !== "rabbitmq") {
                issue("url", `${ISSUE}.urlCredentials`);
            }
        }
        if (value.managementUrl) {
            const url = normalizeEndpointUrl(value.managementUrl);
            if (!url || url.protocol !== "https:") issue("managementUrl", `${ISSUE}.https`);
        }
    })
    .transform((value) => ({
        ...value,
        url:
            value.engine === "kafka"
                ? normalizeBrokers(value.url)
                : urlText(normalizeEndpointUrl(value.url) as URL),
        managementUrl: value.managementUrl
            ? urlText(normalizeEndpointUrl(value.managementUrl) as URL)
            : ""
    }));

export type CloudConnectInput = z.input<typeof cloudConnectSchema>;
export type CloudConnect = z.output<typeof cloudConnectSchema>;

/** The endpoint a connected cloud instance is reached at. */
export function cloudEndpoint(input: CloudConnect): DataEndpoint {
    if (input.engine === "kafka") {
        const sasl = Boolean(input.username);
        const tls = input.provider !== "other" || input.tls;
        return {
            ...EMPTY_ENDPOINT,
            url: input.url,
            brokers: input.url,
            host: input.url.split(",")[0]?.split(":")[0] ?? "",
            port: Number(input.url.split(",")[0]?.split(":")[1] ?? 0),
            username: input.username,
            password: input.password,
            saslMechanism: sasl ? input.saslMechanism || "PLAIN" : "",
            // A managed broker is reached over TLS; the ones listed all require it.
            securityProtocol: `${sasl ? "SASL_" : ""}${tls ? "SSL" : "PLAINTEXT"}`
        };
    }
    const url = new URL(input.url);
    const defaultPort: Record<string, number> = { "https:": 443, "http:": 80, "amqps:": 5671, "amqp:": 5672 };
    const endpoint: DataEndpoint = {
        ...EMPTY_ENDPOINT,
        url: input.url,
        host: url.hostname,
        port: url.port ? Number(url.port) : (defaultPort[url.protocol] ?? 0),
        username: input.username || decodeURIComponent(url.username),
        password: input.password || decodeURIComponent(url.password),
        database: input.database,
        token: input.token,
        org: input.org,
        region: input.region,
        managementUrl: input.managementUrl
    };
    if (input.engine === "clickhouse") {
        // ClickHouse Cloud's native protocol is TLS on 9440.
        const database = input.database || "default";
        return {
            ...endpoint,
            database,
            nativeUrl: `clickhouse://${encodeURIComponent(endpoint.username)}:${encodeURIComponent(endpoint.password)}@${url.hostname}:9440/${database}?secure=true`
        };
    }
    if (input.engine === "rabbitmq") {
        const vhost = decodeURIComponent(url.pathname.replace(/^\//, "")) || "/";
        return { ...endpoint, database: vhost };
    }
    return endpoint;
}

/** Creating a RabbitMQ in CloudAMQP with the user's own API key. */
export const cloudAmqpCreateSchema = z.object({
    environmentId: z.string().uuid(),
    name: z
        .string()
        .trim()
        .min(1, `${ISSUE}.nameRequired`)
        .max(64, `${ISSUE}.tooLong`)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, `${ISSUE}.amqpName`),
    apiKey: z.string().trim().min(8, `${ISSUE}.apiKey`).max(256, `${ISSUE}.tooLong`),
    /** A plan id from CloudAMQP's list, such as `lemur` (free) or `bunny-1`. */
    plan: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9-]{2,40}$/, `${ISSUE}.plan`),
    /** `provider::region`, such as `amazon-web-services::us-east-1`. */
    region: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9-]+::[a-z0-9-]+$/, `${ISSUE}.region`)
});
export type CloudAmqpCreateInput = z.input<typeof cloudAmqpCreateSchema>;

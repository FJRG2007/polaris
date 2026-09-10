/**
 * One-click services: well-known self-hosted apps a project can add from a list
 * instead of typing an image, its port, its volumes and its variables.
 *
 * Transcribed from the openship app catalog (packages/core/src/apps/catalog, at
 * 30ae48a4): the image, port, command, variables, volumes and setup commands of
 * each template whose containers are plain images. A secret is generated the way
 * that catalog generates one - 32 random bytes as hex - and stored as a secret
 * variable on the service, where it can be revealed.
 *
 * Three things a template can need beside its own container:
 *
 * - A database. Polaris provisions one of its managed databases next to the
 *   service, and the service's variables point at it by reference
 *   (`{{database.HOST}}` is written `${{<database>.HOST}}`), so no password is
 *   copied into the service.
 * - A companion: a second plain image created as a second service in the same
 *   environment, which the first reaches by its private domain. It is never
 *   given a public address.
 * - Setup steps, run inside the container once its first deploy is serving: a
 *   readiness test polled until it passes, then the command.
 *
 * `{{publicUrl}}` in a value is the service's own public address, written as the
 * reference Polaris resolves at deploy time, so it follows the domain the service
 * is given rather than being frozen at creation. `{{self.KEY}}`,
 * `{{database.KEY}}` and `{{companion.KEY}}` are the same for any key those
 * answer to.
 */

import { z } from "zod";
import type { DbEngine } from "./schemas/database.js";

/** One container a template runs: the service it creates, or its companion. */
export interface TemplateService {
    readonly image: string;
    /** The port it listens on inside the container. */
    readonly port: number;
    /** The container's arguments in place of the image's own, passed as they are
     *  rather than through a shell - for an image that does nothing without them. */
    readonly command?: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    /** Variables generated as secrets when the service is created. */
    readonly secrets: readonly string[];
    readonly volumes: readonly { readonly name: string; readonly mountPath: string }[];
}

/** A second service a template creates beside the first. */
export interface TemplateCompanion extends TemplateService {
    /** Appended to the service's slug to name it: `kafka` makes `kafka-broker`. */
    readonly suffix: string;
    /** What it is, in the picker's words. */
    readonly label: string;
}

/** A managed database a template's service connects to. */
export interface TemplateDatabase {
    readonly engine: DbEngine;
    /** One of the versions Polaris offers for the engine. */
    readonly version: string;
}

/** A command run inside the service once it is serving. */
export interface TemplatePrepareStep {
    readonly title: string;
    readonly command: string;
    /** Run every `intervalMs` until it exits 0, at most `retries` times, before
     *  the command runs. */
    readonly readiness: {
        readonly test: string;
        readonly intervalMs: number;
        readonly retries: number;
    };
}

export interface ServiceTemplate extends TemplateService {
    readonly id: string;
    readonly name: string;
    /** One line on what it is. */
    readonly description: string;
    /** What to do first, in the service's own words. */
    readonly firstRun: string;
    readonly database?: TemplateDatabase;
    readonly companion?: TemplateCompanion;
    readonly prepare?: readonly TemplatePrepareStep[];
}

/** The value a template writes for the service's own public address. */
export const PUBLIC_URL_PLACEHOLDER = "{{publicUrl}}";

export const SERVICE_TEMPLATES: readonly ServiceTemplate[] = [
    {
        id: "code-server",
        name: "code-server",
        description: "VS Code in the browser, on your server.",
        image: "codercom/code-server:4.132.0",
        port: 8080,
        env: {},
        secrets: ["PASSWORD"],
        volumes: [{ name: "home", mountPath: "/home/coder" }],
        firstRun: "Sign in with the PASSWORD variable."
    },
    {
        id: "directus",
        name: "Directus",
        description: "Headless CMS with a REST and GraphQL API over your data.",
        image: "directus/directus:latest",
        port: 8055,
        env: {
            DB_CLIENT: "sqlite3",
            DB_FILENAME: "/directus/database/data.db",
            PUBLIC_URL: PUBLIC_URL_PLACEHOLDER,
            ADMIN_EMAIL: "admin@example.com"
        },
        secrets: ["SECRET", "ADMIN_PASSWORD"],
        volumes: [
            { name: "database", mountPath: "/directus/database" },
            { name: "uploads", mountPath: "/directus/uploads" }
        ],
        firstRun: "Sign in as admin@example.com with the ADMIN_PASSWORD variable."
    },
    {
        id: "excalidraw",
        name: "Excalidraw",
        description: "Whiteboard for sketches and diagrams. Drawings stay in the browser.",
        image: "excalidraw/excalidraw:latest",
        port: 80,
        env: {},
        secrets: [],
        volumes: [],
        firstRun: "No sign-in."
    },
    {
        id: "freshrss",
        name: "FreshRSS",
        description: "RSS and Atom feed reader.",
        image: "freshrss/freshrss:latest",
        port: 80,
        env: { FRESHRSS_ADMIN_USERNAME: "admin" },
        secrets: ["FRESHRSS_ADMIN_PASSWORD"],
        volumes: [{ name: "data", mountPath: "/var/www/FreshRSS/data" }],
        // The headless installer, so the public web installer is never left open
        // for whoever reaches it first.
        prepare: [
            {
                title: "Install FreshRSS",
                command:
                    'cd /var/www/FreshRSS && { [ -f ./data/config.php ] || php ./cli/do-install.php --default-user="$FRESHRSS_ADMIN_USERNAME" --auth-type=form --db-type=sqlite --api-enabled; } && { php ./cli/list-users.php 2>/dev/null | grep -qx "$FRESHRSS_ADMIN_USERNAME" || php ./cli/create-user.php --user "$FRESHRSS_ADMIN_USERNAME" --password "$FRESHRSS_ADMIN_PASSWORD" --language en; } && ./cli/access-permissions.sh >/dev/null 2>&1; echo done',
                readiness: { test: "test -d /var/www/FreshRSS/cli", intervalMs: 3000, retries: 30 }
            }
        ],
        firstRun: "Once setup has run, sign in as admin with the FRESHRSS_ADMIN_PASSWORD variable."
    },
    {
        id: "ghost",
        name: "Ghost",
        description: "Publishing platform for blogs, newsletters and memberships.",
        image: "ghost:5-alpine",
        port: 2368,
        // The catalog runs mysql:8.0; 8 is the closest version Polaris offers.
        database: { engine: "mysql", version: "8" },
        env: {
            NODE_ENV: "production",
            url: PUBLIC_URL_PLACEHOLDER,
            database__client: "mysql",
            // The managed database's own account, which owns its database; the
            // catalog signed in as root.
            database__connection__host: "{{database.HOST}}",
            database__connection__user: "{{database.USER}}",
            database__connection__password: "{{database.PASSWORD}}",
            database__connection__database: "{{database.DATABASE}}"
        },
        secrets: [],
        volumes: [{ name: "content", mountPath: "/var/lib/ghost/content" }],
        firstRun:
            "Open /ghost/ right away and create the owner account - until then anyone who opens it can."
    },
    {
        id: "gitea",
        name: "Gitea",
        description: "Git hosting with issues and pull requests.",
        image: "gitea/gitea:1",
        port: 3000,
        env: {
            GITEA__server__ROOT_URL: PUBLIC_URL_PLACEHOLDER,
            GITEA__security__INSTALL_LOCK: "true",
            GITEA__database__DB_TYPE: "sqlite3",
            GITEA__service__DISABLE_REGISTRATION: "true",
            GITEA_ADMIN_USERNAME: "admin",
            GITEA_ADMIN_EMAIL: "admin@example.com"
        },
        // The catalog generates GITEA_SECRET_KEY and writes it into
        // GITEA__security__SECRET_KEY; the variable Gitea reads is the secret here.
        secrets: ["GITEA__security__SECRET_KEY", "GITEA_ADMIN_PASSWORD"],
        volumes: [{ name: "data", mountPath: "/data" }],
        prepare: [
            {
                title: "Create the Gitea admin",
                command:
                    'su-exec git gitea admin user create --admin --username "$GITEA_ADMIN_USERNAME" --password "$GITEA_ADMIN_PASSWORD" --email "$GITEA_ADMIN_EMAIL" --must-change-password=false 2>&1 || true; echo done',
                readiness: {
                    test: "su-exec git gitea admin user list >/dev/null 2>&1",
                    intervalMs: 3000,
                    retries: 40
                }
            }
        ],
        firstRun:
            "Once setup has run, sign in as admin with the GITEA_ADMIN_PASSWORD variable. Registration is off."
    },
    {
        id: "grafana",
        name: "Grafana",
        description: "Dashboards for metrics and logs.",
        image: "grafana/grafana:latest",
        port: 3000,
        env: { GF_SERVER_ROOT_URL: PUBLIC_URL_PLACEHOLDER },
        secrets: [],
        volumes: [{ name: "data", mountPath: "/var/lib/grafana" }],
        firstRun: "The first sign-in is admin / admin, and it asks for a new password."
    },
    {
        id: "it-tools",
        name: "IT-Tools",
        description: "Developer and sysadmin utilities in one page.",
        image: "corentinth/it-tools:latest",
        port: 80,
        env: {},
        secrets: [],
        volumes: [],
        firstRun: "No sign-in."
    },
    {
        id: "kafka",
        name: "Apache Kafka",
        description:
            "Event-streaming broker, with a web console for topics, messages and consumer groups.",
        image: "ghcr.io/kafbat/kafka-ui:latest",
        port: 8080,
        env: {
            KAFKA_CLUSTERS_0_NAME: "local",
            KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: "{{companion.POLARIS_PRIVATE_DOMAIN}}:9092",
            DYNAMIC_CONFIG_ENABLED: "true",
            AUTH_TYPE: "LOGIN_FORM",
            SPRING_SECURITY_USER_NAME: "admin"
        },
        secrets: ["SPRING_SECURITY_USER_PASSWORD"],
        volumes: [],
        // KRaft mode, one node that is both broker and controller. The catalog's
        // `kafka` host is the broker's own name, which here is its private domain.
        companion: {
            suffix: "broker",
            label: "Kafka broker",
            image: "apache/kafka:4.0.0",
            port: 9092,
            env: {
                KAFKA_NODE_ID: "1",
                KAFKA_PROCESS_ROLES: "broker,controller",
                KAFKA_LISTENERS: "PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093",
                KAFKA_ADVERTISED_LISTENERS: "PLAINTEXT://{{self.POLARIS_PRIVATE_DOMAIN}}:9092",
                KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
                KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
                KAFKA_INTER_BROKER_LISTENER_NAME: "PLAINTEXT",
                KAFKA_CONTROLLER_QUORUM_VOTERS: "1@{{self.POLARIS_PRIVATE_DOMAIN}}:9093",
                KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
                KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
                KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
                KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: "0",
                KAFKA_NUM_PARTITIONS: "3",
                KAFKA_LOG_DIRS: "/var/lib/kafka/data"
            },
            secrets: [],
            volumes: [{ name: "data", mountPath: "/var/lib/kafka/data" }]
        },
        firstRun:
            "Sign in to the console as admin with the SPRING_SECURITY_USER_PASSWORD variable. Services in this environment reach the broker at its private domain, port 9092."
    },
    {
        id: "meilisearch",
        name: "Meilisearch",
        description: "Typo-tolerant search engine with an HTTP API.",
        image: "getmeili/meilisearch:v1.12",
        port: 7700,
        env: { MEILI_ENV: "production", MEILI_NO_ANALYTICS: "true" },
        secrets: ["MEILI_MASTER_KEY"],
        volumes: [{ name: "data", mountPath: "/meili_data" }],
        firstRun: "Clients authenticate with the MEILI_MASTER_KEY variable."
    },
    {
        id: "metabase",
        name: "Metabase",
        description: "Business intelligence: dashboards and questions over your data.",
        image: "metabase/metabase:latest",
        port: 3000,
        env: { MB_DB_FILE: "/metabase-data/metabase.db", MB_SITE_URL: PUBLIC_URL_PLACEHOLDER },
        secrets: ["MB_ENCRYPTION_SECRET_KEY"],
        volumes: [{ name: "data", mountPath: "/metabase-data" }],
        firstRun: "Create the admin account on the first visit."
    },
    {
        id: "minio",
        name: "MinIO",
        description: "S3-compatible object storage with a web console.",
        image: "minio/minio:latest",
        port: 9001,
        // Unwrapped: the image's entrypoint prepends `minio` to these, and a shell
        // in front of them would be taken for a MinIO subcommand.
        command: ["server", "/data", "--console-address", ":9001"],
        env: {
            MINIO_BROWSER_REDIRECT_URL: PUBLIC_URL_PLACEHOLDER,
            MINIO_ROOT_USER: "minio",
            OPENSHIP_BUCKET: "uploads"
        },
        secrets: ["MINIO_ROOT_PASSWORD"],
        volumes: [{ name: "data", mountPath: "/data" }],
        prepare: [
            {
                title: "Create the first bucket",
                command:
                    'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" > /dev/null && mc mb --ignore-existing "local/$OPENSHIP_BUCKET" > /dev/null && printf \'%s\' "$OPENSHIP_BUCKET"',
                readiness: {
                    test: 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"',
                    intervalMs: 1000,
                    retries: 30
                }
            }
        ],
        firstRun:
            "Sign in to the console as minio with the MINIO_ROOT_PASSWORD variable. The S3 API answers on port 9000 at the service's private domain, and the first bucket is named in OPENSHIP_BUCKET."
    },
    {
        id: "n8n",
        name: "n8n",
        description: "Workflow automation with a visual editor.",
        image: "n8nio/n8n:latest",
        port: 5678,
        env: {
            N8N_PORT: "5678",
            N8N_PROTOCOL: "https",
            GENERIC_TIMEZONE: "UTC",
            WEBHOOK_URL: PUBLIC_URL_PLACEHOLDER
        },
        secrets: ["N8N_ENCRYPTION_KEY"],
        volumes: [{ name: "data", mountPath: "/home/node/.n8n" }],
        firstRun: "Create the owner account on the first visit."
    },
    {
        id: "nocodb",
        name: "NocoDB",
        description: "Spreadsheet interface over an SQL database.",
        image: "nocodb/nocodb:latest",
        port: 8080,
        env: { NC_ADMIN_EMAIL: "admin@example.com" },
        secrets: ["NC_ADMIN_PASSWORD"],
        volumes: [{ name: "data", mountPath: "/usr/app/data" }],
        firstRun: "Sign in as admin@example.com with the NC_ADMIN_PASSWORD variable."
    },
    {
        id: "qdrant",
        name: "Qdrant",
        description: "Vector database for search and embeddings, with a web UI.",
        image: "qdrant/qdrant:v1.18.3",
        port: 6333,
        env: {},
        secrets: ["QDRANT__SERVICE__API_KEY"],
        volumes: [{ name: "storage", mountPath: "/qdrant/storage" }],
        firstRun: "Clients authenticate with the QDRANT__SERVICE__API_KEY variable."
    },
    {
        id: "stirling-pdf",
        name: "Stirling PDF",
        description: "Split, merge, convert and OCR PDFs on your own server.",
        image: "stirlingtools/stirling-pdf:latest",
        port: 8080,
        env: { SECURITY_ENABLELOGIN: "true", SECURITY_INITIALLOGIN_USERNAME: "admin" },
        secrets: ["SECURITY_INITIALLOGIN_PASSWORD"],
        volumes: [
            { name: "configs", mountPath: "/configs" },
            { name: "tessdata", mountPath: "/usr/share/tessdata" }
        ],
        firstRun: "Sign in as admin with the SECURITY_INITIALLOGIN_PASSWORD variable."
    },
    {
        id: "umami",
        name: "Umami",
        description: "Cookie-free web analytics.",
        image: "ghcr.io/umami-software/umami:postgresql-v2.19.0",
        port: 3000,
        database: { engine: "postgres", version: "16" },
        env: { DATABASE_TYPE: "postgresql", DATABASE_URL: "{{database.DATABASE_URL}}" },
        secrets: ["APP_SECRET"],
        volumes: [],
        firstRun:
            "Sign in as admin with the password umami, then change it under Settings, Profile."
    },
    {
        id: "uptime-kuma",
        name: "Uptime Kuma",
        description: "Uptime monitoring with status pages and alerts.",
        image: "louislam/uptime-kuma:1",
        port: 3001,
        env: {},
        secrets: [],
        volumes: [{ name: "data", mountPath: "/app/data" }],
        firstRun:
            "Create the admin account on the first visit - until then anyone who opens it can."
    },
    {
        id: "vaultwarden",
        name: "Vaultwarden",
        description: "Bitwarden-compatible password manager.",
        image: "vaultwarden/server:latest",
        port: 80,
        env: { DOMAIN: PUBLIC_URL_PLACEHOLDER, SIGNUPS_ALLOWED: "false" },
        secrets: ["ADMIN_TOKEN"],
        volumes: [{ name: "data", mountPath: "/data" }],
        firstRun: "Open /admin with the ADMIN_TOKEN variable to invite the first account."
    }
];

export const serviceTemplateIdSchema = z.enum(
    SERVICE_TEMPLATES.map((template) => template.id) as [string, ...string[]]
);

export function serviceTemplate(id: string): ServiceTemplate | null {
    return SERVICE_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** Whether creating a template takes more than one deploy of one container. */
export function templateNeedsSetup(template: ServiceTemplate): boolean {
    return Boolean(template.database || template.companion || template.prepare?.length);
}

/** The slugs a template's `{{self...}}`, `{{database...}}` and
 *  `{{companion...}}` stand for, once the services and database exist. */
export interface TemplateSlugs {
    readonly self: string;
    readonly database?: string;
    readonly companion?: string;
}

const TEMPLATE_REFERENCE = /\{\{(self|database|companion)\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * A service's variables as it stores them: every placeholder written as the
 * reference it stands for, and each secret from `generate`.
 *
 * Throws on a placeholder for a database or companion the caller has no slug for
 * - a template that names one it does not create, which would otherwise deploy
 * with a reference to nothing.
 */
export function templateVariables(
    service: TemplateService,
    slugs: TemplateSlugs,
    generate: () => string
): { key: string; value: string; isSecret: boolean }[] {
    const wire = (value: string): string =>
        value
            .split(PUBLIC_URL_PLACEHOLDER)
            .join("{{self.POLARIS_PUBLIC_URL}}")
            .replace(TEMPLATE_REFERENCE, (_written, who: keyof TemplateSlugs, key: string) => {
                const slug = slugs[who];
                if (!slug) throw new Error(`The template refers to a ${who} it does not create`);
                return `\${{${slug}.${key}}}`;
            });
    return [
        ...Object.entries(service.env).map(([key, value]) => ({
            key,
            value: wire(value),
            isSecret: false
        })),
        ...service.secrets.map((key) => ({ key, value: generate(), isSecret: true }))
    ];
}

/**
 * The first of `base`, `base-2`, `base-3`... that `taken` does not hold.
 *
 * A template's database and companion are named after its service, and share
 * the environment's names with every other service and database in it: a
 * reference looks services up before databases, so a database that shared a
 * service's name would never be the one found.
 */
export function freeTemplateName(base: string, taken: ReadonlySet<string>): string {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** What running one command inside a service answered. */
export interface PrepareExecResult {
    readonly code: number;
    readonly output: string;
}

export type PrepareOutcome =
    | { readonly ok: true; readonly title: string; readonly output: string }
    | {
          readonly ok: false;
          readonly title: string;
          readonly reason: string;
          readonly output: string;
      };

/**
 * Run a template's setup steps, in order, through `exec`.
 *
 * Each step's readiness test runs until it exits 0, `retries` times at most with
 * `intervalMs` between them; a test that throws (the container restarting under
 * it) counts as not ready yet. Then the command runs once. The first step that
 * fails ends the run - a later one may need what it was to do - and the
 * outcomes answer every step that ran, so a failure is never silent.
 */
export async function runPrepareSteps(
    steps: readonly TemplatePrepareStep[],
    exec: (command: string) => Promise<PrepareExecResult>,
    sleep: (ms: number) => Promise<void>
): Promise<PrepareOutcome[]> {
    const outcomes: PrepareOutcome[] = [];
    for (const step of steps) {
        const { test, intervalMs, retries } = step.readiness;
        let ready = false;
        for (let attempt = 1; attempt <= retries && !ready; attempt += 1) {
            const result = await exec(test).catch(() => null);
            ready = result?.code === 0;
            if (!ready && attempt < retries) await sleep(intervalMs);
        }
        if (!ready) {
            outcomes.push({
                ok: false,
                title: step.title,
                reason: `It was not ready after ${retries} checks ${intervalMs / 1000} seconds apart.`,
                output: ""
            });
            return outcomes;
        }
        let result: PrepareExecResult;
        try {
            result = await exec(step.command);
        } catch (error) {
            const reason =
                error instanceof Error && error.message ? error.message : "It could not be run.";
            outcomes.push({ ok: false, title: step.title, reason, output: "" });
            return outcomes;
        }
        const output = result.output.trim();
        if (result.code !== 0) {
            outcomes.push({
                ok: false,
                title: step.title,
                reason: `It exited with code ${result.code}.`,
                output
            });
            return outcomes;
        }
        outcomes.push({ ok: true, title: step.title, output });
    }
    return outcomes;
}

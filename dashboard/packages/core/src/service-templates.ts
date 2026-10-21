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
    /** Other sites frame what it serves - a shared dashboard, a status page, an
     *  embedded form - so it starts without the recommended headers, whose
     *  same-site framing would break those embeds, the way a catalog app does. */
    readonly embedded?: boolean;
}

/** The value a template writes for the service's own public address. */
export const PUBLIC_URL_PLACEHOLDER = "{{publicUrl}}";

/** One line of PHP for wp-config.php: trust the edge's forwarded scheme. */
export const WORDPRESS_FORWARDED_HTTPS =
    "if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }";

/**
 * MinIO, Meilisearch, Typesense, ClickHouse, InfluxDB, CouchDB, Kafka and
 * RabbitMQ are not here: they are data engines of the "new database" flow
 * (`schemas/data-engines.ts`), where they can run on a server or in a cloud.
 * A service created from one of their old templates is a plain service and
 * keeps working as one.
 */
export const RETIRED_TEMPLATE_IDS = [
    "kafka",
    "meilisearch",
    "minio",
    "clickhouse",
    "couchdb",
    "influxdb",
    "rabbitmq",
    "typesense"
] as const;

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
        embedded: true,
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
        id: "metabase",
        name: "Metabase",
        description: "Business intelligence: dashboards and questions over your data.",
        image: "metabase/metabase:latest",
        port: 3000,
        env: { MB_DB_FILE: "/metabase-data/metabase.db", MB_SITE_URL: PUBLIC_URL_PLACEHOLDER },
        secrets: ["MB_ENCRYPTION_SECRET_KEY"],
        volumes: [{ name: "data", mountPath: "/metabase-data" }],
        embedded: true,
        firstRun: "Create the admin account on the first visit."
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
        embedded: true,
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
        embedded: true,
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
    },
    // Every image below is pinned to a tag checked against its registry when it
    // was added; the variables are the ones each image documents.
    {
        id: "actual",
        name: "Actual Budget",
        description: "Envelope budgeting that syncs across your devices.",
        image: "actualbudget/actual-server:26.10.0",
        port: 5006,
        env: { ACTUAL_LOGIN_METHOD: "password" },
        secrets: [],
        volumes: [{ name: "data", mountPath: "/data" }],
        firstRun: "Set the server password on the first visit - until then anyone who opens it can."
    },
    {
        id: "anythingllm",
        name: "AnythingLLM",
        description: "Chat with your documents through the model of your choice.",
        image: "mintplexlabs/anythingllm:1.18.0",
        port: 3001,
        env: { STORAGE_DIR: "/app/server/storage", DISABLE_TELEMETRY: "true" },
        secrets: ["JWT_SECRET", "SIG_KEY", "SIG_SALT"],
        volumes: [{ name: "storage", mountPath: "/app/server/storage" }],
        firstRun:
            "Pick a model provider on the first visit, then turn on a password under Settings, Security."
    },
    {
        id: "audiobookshelf",
        name: "Audiobookshelf",
        description: "Audiobook and podcast server with progress sync.",
        image: "ghcr.io/advplyr/audiobookshelf:2.37.1",
        port: 80,
        env: {},
        secrets: [],
        volumes: [
            { name: "config", mountPath: "/config" },
            { name: "metadata", mountPath: "/metadata" },
            { name: "audiobooks", mountPath: "/audiobooks" },
            { name: "podcasts", mountPath: "/podcasts" }
        ],
        firstRun: "Create the root account on the first visit - until then anyone who opens it can."
    },
    {
        id: "beszel",
        name: "Beszel",
        description: "Lightweight server monitoring with history and alerts.",
        image: "henrygd/beszel:0.21.0",
        port: 8090,
        env: {},
        secrets: [],
        volumes: [{ name: "data", mountPath: "/beszel_data" }],
        firstRun:
            "Create the admin account on the first visit - until then anyone who opens it can."
    },
    {
        id: "calibre-web",
        name: "Calibre-Web",
        description: "Browse, read and download books from a Calibre library.",
        image: "linuxserver/calibre-web:0.6.27",
        port: 8083,
        env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
        secrets: [],
        volumes: [
            { name: "config", mountPath: "/config" },
            { name: "books", mountPath: "/books" }
        ],
        firstRun:
            "Sign in as admin with the password admin123 and change it right away. Point it at /books once a library is there."
    },
    {
        id: "chroma",
        name: "Chroma",
        description: "Embedding database for AI apps.",
        image: "chromadb/chroma:1.5.9",
        port: 8000,
        env: { IS_PERSISTENT: "TRUE", PERSIST_DIRECTORY: "/data", ANONYMIZED_TELEMETRY: "FALSE" },
        secrets: [],
        volumes: [{ name: "data", mountPath: "/data" }],
        firstRun:
            "It has no sign-in: leave it without a public address and reach it on its private domain, port 8000."
    },
    {
        id: "flowise",
        name: "Flowise",
        description: "Build LLM agents and flows with a visual editor.",
        image: "flowiseai/flowise:3.1.4",
        port: 3000,
        env: {
            PORT: "3000",
            DATABASE_PATH: "/root/.flowise",
            APIKEY_PATH: "/root/.flowise",
            SECRETKEY_PATH: "/root/.flowise",
            LOG_PATH: "/root/.flowise/logs"
        },
        secrets: ["FLOWISE_SECRETKEY_OVERWRITE"],
        volumes: [{ name: "data", mountPath: "/root/.flowise" }],
        firstRun:
            "Create the admin account on the first visit - until then anyone who opens it can."
    },
    {
        id: "gotify",
        name: "Gotify",
        description: "Push notifications for your own apps and scripts.",
        image: "gotify/server:2.9.0",
        port: 80,
        env: {
            GOTIFY_DEFAULTUSER_NAME: "admin",
            GOTIFY_REGISTRATION: "false",
            GOTIFY_DATABASE_DIALECT: "sqlite3",
            GOTIFY_DATABASE_CONNECTION: "data/gotify.db"
        },
        secrets: ["GOTIFY_DEFAULTUSER_PASS"],
        volumes: [{ name: "data", mountPath: "/app/data" }],
        firstRun: "Sign in as admin with the GOTIFY_DEFAULTUSER_PASS variable."
    },
    {
        id: "grav",
        name: "Grav",
        description: "Flat-file CMS, no database needed.",
        image: "linuxserver/grav:2.2.9",
        port: 80,
        env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
        secrets: [],
        volumes: [{ name: "config", mountPath: "/config" }],
        firstRun:
            "Open /admin right away and create the admin account - until then anyone who opens it can."
    },
    {
        id: "jaeger",
        name: "Jaeger",
        description: "Distributed tracing: follow a request across services.",
        image: "jaegertracing/jaeger:2.22.0",
        port: 16686,
        env: {},
        secrets: [],
        volumes: [],
        firstRun:
            "Send OTLP traces to its private domain, port 4317 (gRPC) or 4318 (HTTP). Traces are kept in memory and cleared on restart."
    },
    {
        id: "jellyfin",
        name: "Jellyfin",
        description: "Stream your movies, shows and music to any device.",
        image: "jellyfin/jellyfin:10.11",
        port: 8096,
        env: {},
        secrets: [],
        volumes: [
            { name: "config", mountPath: "/config" },
            { name: "cache", mountPath: "/cache" },
            { name: "media", mountPath: "/media" }
        ],
        firstRun:
            "Finish the setup wizard on the first visit - until then anyone who opens it can. Libraries go under /media."
    },
    {
        id: "keycloak",
        name: "Keycloak",
        description: "Single sign-on and identity management.",
        image: "quay.io/keycloak/keycloak:26.8.1",
        port: 8080,
        command: ["start"],
        database: { engine: "postgres", version: "17" },
        env: {
            KC_DB: "postgres",
            KC_DB_URL_HOST: "{{database.HOST}}",
            KC_DB_URL_PORT: "{{database.PORT}}",
            KC_DB_URL_DATABASE: "{{database.DATABASE}}",
            KC_DB_USERNAME: "{{database.USER}}",
            KC_DB_PASSWORD: "{{database.PASSWORD}}",
            KC_HOSTNAME: PUBLIC_URL_PLACEHOLDER,
            KC_HTTP_ENABLED: "true",
            KC_PROXY_HEADERS: "xforwarded",
            KC_BOOTSTRAP_ADMIN_USERNAME: "admin"
        },
        secrets: ["KC_BOOTSTRAP_ADMIN_PASSWORD"],
        volumes: [],
        firstRun:
            "Sign in as admin with the KC_BOOTSTRAP_ADMIN_PASSWORD variable, then create a permanent admin; the bootstrap one is temporary."
    },
    {
        id: "langflow",
        name: "Langflow",
        description: "Visual builder for AI agents and RAG pipelines.",
        image: "langflowai/langflow:1.12.6",
        port: 7860,
        database: { engine: "postgres", version: "17" },
        env: {
            LANGFLOW_DATABASE_URL:
                "postgresql://{{database.USER}}:{{database.PASSWORD}}@{{database.HOST}}:{{database.PORT}}/{{database.DATABASE}}",
            LANGFLOW_CONFIG_DIR: "/app/langflow",
            LANGFLOW_HOST: "0.0.0.0",
            LANGFLOW_AUTO_LOGIN: "false",
            LANGFLOW_SUPERUSER: "admin"
        },
        secrets: ["LANGFLOW_SECRET_KEY", "LANGFLOW_SUPERUSER_PASSWORD"],
        volumes: [{ name: "data", mountPath: "/app/langflow" }],
        firstRun: "Sign in as admin with the LANGFLOW_SUPERUSER_PASSWORD variable."
    },
    {
        id: "linkding",
        name: "linkding",
        description: "Bookmark manager with tags and a browser extension.",
        image: "sissbruecker/linkding:1.47.0",
        port: 9090,
        env: { LD_SUPERUSER_NAME: "admin" },
        secrets: ["LD_SUPERUSER_PASSWORD"],
        volumes: [{ name: "data", mountPath: "/etc/linkding/data" }],
        firstRun: "Sign in as admin with the LD_SUPERUSER_PASSWORD variable."
    },
    {
        id: "loki",
        name: "Loki",
        description: "Log storage you query from Grafana.",
        image: "grafana/loki:3.6.0",
        port: 3100,
        env: {},
        secrets: [],
        volumes: [{ name: "data", mountPath: "/loki" }],
        firstRun:
            "It has no sign-in: leave it without a public address and add its private domain, port 3100, as a Grafana data source."
    },
    {
        id: "mattermost",
        name: "Mattermost",
        description: "Team chat with channels, threads and integrations.",
        image: "mattermost/mattermost-team-edition:11.7.12",
        port: 8065,
        database: { engine: "postgres", version: "17" },
        env: {
            MM_SQLSETTINGS_DRIVERNAME: "postgres",
            MM_SQLSETTINGS_DATASOURCE:
                "postgres://{{database.USER}}:{{database.PASSWORD}}@{{database.HOST}}:{{database.PORT}}/{{database.DATABASE}}?sslmode=disable&connect_timeout=10",
            MM_SERVICESETTINGS_SITEURL: PUBLIC_URL_PLACEHOLDER
        },
        secrets: [],
        volumes: [
            { name: "config", mountPath: "/mattermost/config" },
            { name: "data", mountPath: "/mattermost/data" },
            { name: "logs", mountPath: "/mattermost/logs" },
            { name: "plugins", mountPath: "/mattermost/plugins" }
        ],
        firstRun: "Create the first account right away - it becomes the system admin."
    },
    {
        id: "memos",
        name: "Memos",
        description: "Quick notes and a private timeline, in Markdown.",
        image: "neosmemo/memos:0.31.0",
        port: 5230,
        env: {},
        secrets: [],
        volumes: [{ name: "data", mountPath: "/var/opt/memos" }],
        firstRun: "Create the first account right away - it becomes the admin."
    },
    {
        id: "miniflux",
        name: "Miniflux",
        description: "Minimal, fast feed reader.",
        image: "miniflux/miniflux:2.3.3",
        port: 8080,
        database: { engine: "postgres", version: "17" },
        env: {
            DATABASE_URL:
                "postgres://{{database.USER}}:{{database.PASSWORD}}@{{database.HOST}}:{{database.PORT}}/{{database.DATABASE}}?sslmode=disable",
            RUN_MIGRATIONS: "1",
            CREATE_ADMIN: "1",
            ADMIN_USERNAME: "admin",
            BASE_URL: PUBLIC_URL_PLACEHOLDER
        },
        secrets: ["ADMIN_PASSWORD"],
        volumes: [],
        firstRun: "Sign in as admin with the ADMIN_PASSWORD variable."
    },
    {
        id: "navidrome",
        name: "Navidrome",
        description: "Music streaming server that works with Subsonic apps.",
        image: "deluan/navidrome:0.64.2",
        port: 4533,
        env: {},
        secrets: [],
        volumes: [
            { name: "data", mountPath: "/data" },
            { name: "music", mountPath: "/music" }
        ],
        firstRun:
            "Create the admin account on the first visit - until then anyone who opens it can. Music goes under /music."
    },
    {
        id: "nextcloud",
        name: "Nextcloud",
        description: "Files, calendars and contacts with a large app store.",
        image: "nextcloud:32-apache",
        port: 80,
        database: { engine: "postgres", version: "17" },
        env: {
            POSTGRES_HOST: "{{database.HOST}}:{{database.PORT}}",
            POSTGRES_DB: "{{database.DATABASE}}",
            POSTGRES_USER: "{{database.USER}}",
            POSTGRES_PASSWORD: "{{database.PASSWORD}}",
            NEXTCLOUD_ADMIN_USER: "admin",
            NEXTCLOUD_TRUSTED_DOMAINS: "{{self.POLARIS_PUBLIC_DOMAIN}}",
            OVERWRITEPROTOCOL: "https",
            OVERWRITECLIURL: PUBLIC_URL_PLACEHOLDER
        },
        secrets: ["NEXTCLOUD_ADMIN_PASSWORD"],
        volumes: [{ name: "html", mountPath: "/var/www/html" }],
        firstRun:
            "Sign in as admin with the NEXTCLOUD_ADMIN_PASSWORD variable. The first start takes a few minutes."
    },
    {
        id: "ntfy",
        name: "ntfy",
        description: "Send push notifications to your phone with a plain HTTP request.",
        image: "binwiederhier/ntfy:v2.30.0",
        port: 80,
        command: ["serve"],
        env: {
            NTFY_BASE_URL: PUBLIC_URL_PLACEHOLDER,
            NTFY_BEHIND_PROXY: "true",
            NTFY_CACHE_FILE: "/var/cache/ntfy/cache.db",
            NTFY_AUTH_FILE: "/var/lib/ntfy/user.db",
            NTFY_AUTH_DEFAULT_ACCESS: "deny-all"
        },
        // `ntfy user add` reads the password from NTFY_PASSWORD.
        secrets: ["NTFY_PASSWORD"],
        volumes: [
            { name: "cache", mountPath: "/var/cache/ntfy" },
            { name: "lib", mountPath: "/var/lib/ntfy" }
        ],
        prepare: [
            {
                title: "Create the ntfy admin",
                command:
                    "ntfy user list 2>&1 | grep -q 'user admin' || ntfy user add --role=admin admin; echo done",
                readiness: { test: "test -f /var/lib/ntfy/user.db", intervalMs: 3000, retries: 30 }
            }
        ],
        firstRun:
            "Once setup has run, sign in as admin with the NTFY_PASSWORD variable. Topics are private until you grant access."
    },
    {
        id: "open-webui",
        name: "Open WebUI",
        description: "Chat with local models, with an Ollama server beside it.",
        image: "ghcr.io/open-webui/open-webui:v0.6.30",
        port: 8080,
        env: { OLLAMA_BASE_URL: "http://{{companion.POLARIS_PRIVATE_DOMAIN}}:11434" },
        secrets: ["WEBUI_SECRET_KEY"],
        volumes: [{ name: "data", mountPath: "/app/backend/data" }],
        companion: {
            suffix: "ollama",
            label: "Ollama model server",
            image: "ollama/ollama:0.40.4",
            port: 11434,
            env: {},
            secrets: [],
            volumes: [{ name: "models", mountPath: "/root/.ollama" }]
        },
        firstRun:
            "Create the first account right away - it becomes the admin. Pull a model from Settings, Models."
    },
    {
        id: "paperless-ngx",
        name: "Paperless-ngx",
        description: "Scan, OCR and search your paper documents.",
        image: "ghcr.io/paperless-ngx/paperless-ngx:2.20.0",
        port: 8000,
        database: { engine: "redis", version: "7" },
        env: {
            PAPERLESS_REDIS: "{{database.URL}}",
            PAPERLESS_URL: PUBLIC_URL_PLACEHOLDER,
            PAPERLESS_ADMIN_USER: "admin",
            PAPERLESS_OCR_LANGUAGE: "eng",
            PAPERLESS_TIME_ZONE: "Etc/UTC"
        },
        secrets: ["PAPERLESS_SECRET_KEY", "PAPERLESS_ADMIN_PASSWORD"],
        volumes: [
            { name: "data", mountPath: "/usr/src/paperless/data" },
            { name: "media", mountPath: "/usr/src/paperless/media" },
            { name: "consume", mountPath: "/usr/src/paperless/consume" },
            { name: "export", mountPath: "/usr/src/paperless/export" }
        ],
        firstRun: "Sign in as admin with the PAPERLESS_ADMIN_PASSWORD variable."
    },
    {
        id: "pgadmin",
        name: "pgAdmin",
        description: "Web console for PostgreSQL servers.",
        image: "dpage/pgadmin4:9.18",
        port: 80,
        env: { PGADMIN_DEFAULT_EMAIL: "admin@example.com" },
        secrets: ["PGADMIN_DEFAULT_PASSWORD"],
        volumes: [{ name: "data", mountPath: "/var/lib/pgadmin" }],
        firstRun:
            "Sign in as admin@example.com with the PGADMIN_DEFAULT_PASSWORD variable, then add a server with a database's connection details."
    },
    {
        id: "phpmyadmin",
        name: "phpMyAdmin",
        description: "Web console for MySQL and MariaDB servers.",
        image: "phpmyadmin:5.2.3-apache",
        port: 80,
        env: { PMA_ARBITRARY: "1", UPLOAD_LIMIT: "100M", PMA_ABSOLUTE_URI: PUBLIC_URL_PLACEHOLDER },
        secrets: [],
        volumes: [],
        firstRun:
            "Sign in with a server's host, user and password. A Polaris database's are on its connection details."
    },
    {
        id: "photoprism",
        name: "PhotoPrism",
        description: "Photo library with face recognition, maps and search.",
        image: "photoprism/photoprism:261007",
        port: 2342,
        database: { engine: "mariadb", version: "11" },
        env: {
            PHOTOPRISM_ADMIN_USER: "admin",
            PHOTOPRISM_SITE_URL: PUBLIC_URL_PLACEHOLDER,
            PHOTOPRISM_DATABASE_DRIVER: "mysql",
            PHOTOPRISM_DATABASE_SERVER: "{{database.HOST}}:{{database.PORT}}",
            PHOTOPRISM_DATABASE_NAME: "{{database.DATABASE}}",
            PHOTOPRISM_DATABASE_USER: "{{database.USER}}",
            PHOTOPRISM_DATABASE_PASSWORD: "{{database.PASSWORD}}"
        },
        secrets: ["PHOTOPRISM_ADMIN_PASSWORD"],
        volumes: [
            { name: "storage", mountPath: "/photoprism/storage" },
            { name: "originals", mountPath: "/photoprism/originals" }
        ],
        firstRun: "Sign in as admin with the PHOTOPRISM_ADMIN_PASSWORD variable."
    },
    {
        id: "prometheus",
        name: "Prometheus",
        description: "Metrics collection and alerting.",
        image: "prom/prometheus:v3.15.0",
        port: 9090,
        env: {},
        secrets: [],
        volumes: [{ name: "data", mountPath: "/prometheus" }],
        firstRun:
            "It has no sign-in: leave it without a public address and add its private domain, port 9090, as a Grafana data source."
    },
    {
        id: "prowlarr",
        name: "Prowlarr",
        description: "Indexer manager for Sonarr and Radarr.",
        image: "linuxserver/prowlarr:2.6.5",
        port: 9696,
        env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
        secrets: [],
        volumes: [{ name: "config", mountPath: "/config" }],
        firstRun: "Choose a sign-in method on the first visit - until then anyone who opens it can."
    },
    {
        id: "radarr",
        name: "Radarr",
        description: "Movie collection manager.",
        image: "linuxserver/radarr:6.4.4",
        port: 7878,
        env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
        secrets: [],
        volumes: [
            { name: "config", mountPath: "/config" },
            { name: "movies", mountPath: "/movies" },
            { name: "downloads", mountPath: "/downloads" }
        ],
        firstRun: "Choose a sign-in method on the first visit - until then anyone who opens it can."
    },
    {
        id: "searxng",
        name: "SearXNG",
        description: "Private metasearch engine that does not track you.",
        image: "searxng/searxng:2026.10.13-22c64b8d3",
        port: 8080,
        env: { SEARXNG_BASE_URL: PUBLIC_URL_PLACEHOLDER },
        secrets: ["SEARXNG_SECRET"],
        volumes: [{ name: "config", mountPath: "/etc/searxng" }],
        firstRun: "Open it and search. It has no accounts, so anyone with the address can use it."
    },
    {
        id: "sonarr",
        name: "Sonarr",
        description: "TV series collection manager.",
        image: "linuxserver/sonarr:4.0.20",
        port: 8989,
        env: { PUID: "1000", PGID: "1000", TZ: "Etc/UTC" },
        secrets: [],
        volumes: [
            { name: "config", mountPath: "/config" },
            { name: "tv", mountPath: "/tv" },
            { name: "downloads", mountPath: "/downloads" }
        ],
        firstRun: "Choose a sign-in method on the first visit - until then anyone who opens it can."
    },
    {
        id: "vikunja",
        name: "Vikunja",
        description: "To-do lists and projects with kanban and Gantt views.",
        image: "vikunja/vikunja:0.24.6",
        port: 3456,
        env: {
            VIKUNJA_SERVICE_PUBLICURL: PUBLIC_URL_PLACEHOLDER,
            VIKUNJA_DATABASE_TYPE: "sqlite",
            VIKUNJA_DATABASE_PATH: "/db/vikunja.db"
        },
        secrets: ["VIKUNJA_SERVICE_JWTSECRET"],
        volumes: [
            { name: "db", mountPath: "/db" },
            { name: "files", mountPath: "/app/vikunja/files" }
        ],
        firstRun: "Register the first account. Registration stays open until you turn it off."
    },
    {
        id: "wikijs",
        name: "Wiki.js",
        description: "Wiki with a Markdown editor, search and access rules.",
        image: "ghcr.io/requarks/wiki:2.5",
        port: 3000,
        database: { engine: "postgres", version: "17" },
        env: {
            DB_TYPE: "postgres",
            DB_HOST: "{{database.HOST}}",
            DB_PORT: "{{database.PORT}}",
            DB_USER: "{{database.USER}}",
            DB_PASS: "{{database.PASSWORD}}",
            DB_NAME: "{{database.DATABASE}}"
        },
        secrets: [],
        volumes: [],
        firstRun:
            "Finish setup and create the admin on the first visit - until then anyone who opens it can."
    },
    {
        id: "wordpress",
        name: "WordPress",
        description: "Websites and blogs, with themes and plugins.",
        image: "wordpress:7.1-apache",
        port: 80,
        database: { engine: "mariadb", version: "11" },
        env: {
            WORDPRESS_DB_HOST: "{{database.HOST}}:{{database.PORT}}",
            WORDPRESS_DB_USER: "{{database.USER}}",
            WORDPRESS_DB_PASSWORD: "{{database.PASSWORD}}",
            WORDPRESS_DB_NAME: "{{database.DATABASE}}",
            // TLS ends at the edge, so WordPress sees plain HTTP unless it trusts
            // the forwarded scheme; without this it redirects to http:// forever.
            WORDPRESS_CONFIG_EXTRA: WORDPRESS_FORWARDED_HTTPS
        },
        secrets: [
            "WORDPRESS_AUTH_KEY",
            "WORDPRESS_SECURE_AUTH_KEY",
            "WORDPRESS_LOGGED_IN_KEY",
            "WORDPRESS_NONCE_KEY",
            "WORDPRESS_AUTH_SALT",
            "WORDPRESS_SECURE_AUTH_SALT",
            "WORDPRESS_LOGGED_IN_SALT",
            "WORDPRESS_NONCE_SALT"
        ],
        volumes: [{ name: "html", mountPath: "/var/www/html" }],
        firstRun:
            "Open it right away and finish the installer - until then anyone who opens it can."
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

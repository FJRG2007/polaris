/**
 * One-click services: well-known self-hosted apps a project can add from a list
 * instead of typing an image, its port, its volumes and its variables.
 *
 * Transcribed from the openship app catalog (packages/core/src/apps/catalog, at
 * 30ae48a4): the image, port, variables and volumes of each single-image template
 * that needs nothing run inside it after it starts. The ones that seed an account
 * with a command after start (Gitea, FreshRSS, MinIO) and the multi-container ones
 * are not here. A secret is generated the way that catalog generates one - 32
 * random bytes as hex - and stored as a secret variable on the service, where it
 * can be revealed.
 *
 * `{{publicUrl}}` in a value is the service's own public address, written as the
 * reference Polaris resolves at deploy time, so it follows the domain the service
 * is given rather than being frozen at creation.
 */

import { z } from "zod";

export interface ServiceTemplate {
    readonly id: string;
    readonly name: string;
    /** One line on what it is. */
    readonly description: string;
    readonly image: string;
    /** The port it listens on inside the container. */
    readonly port: number;
    readonly env: Readonly<Record<string, string>>;
    /** Variables generated as secrets when the service is created. */
    readonly secrets: readonly string[];
    readonly volumes: readonly { readonly name: string; readonly mountPath: string }[];
    /** What to do first, in the service's own words. */
    readonly firstRun: string;
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
        id: "uptime-kuma",
        name: "Uptime Kuma",
        description: "Uptime monitoring with status pages and alerts.",
        image: "louislam/uptime-kuma:1",
        port: 3001,
        env: {},
        secrets: [],
        volumes: [{ name: "data", mountPath: "/app/data" }],
        firstRun: "Create the admin account on the first visit - until then anyone who opens it can."
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

/**
 * A template's variables as the service stores them: the public address as a
 * reference to the service itself, and each secret from `generate`.
 */
export function templateVariables(
    template: ServiceTemplate,
    serviceSlug: string,
    generate: () => string
): { key: string; value: string; isSecret: boolean }[] {
    const reference = `\${{${serviceSlug}.POLARIS_PUBLIC_URL}}`;
    return [
        ...Object.entries(template.env).map(([key, value]) => ({
            key,
            value: value.split(PUBLIC_URL_PLACEHOLDER).join(reference),
            isSecret: false
        })),
        ...template.secrets.map((key) => ({ key, value: generate(), isSecret: true }))
    ];
}

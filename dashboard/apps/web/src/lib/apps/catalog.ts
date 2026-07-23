/**
 * The Polaris app marketplace catalog: the fixed set of apps Polaris knows how
 * to install and run. This is code, not data - each entry (a manifest) describes
 * what the app is, how it is installed, what capabilities it provides, and how
 * its dashboard is rendered. A matching InstalledApp row records each install
 * (target, config, secret, status). New apps are added here.
 *
 * Mirrors the shape of lib/integrations/registry.ts. Installing a
 * `compose-template` app reuses Deploy (a compose stack on a chosen DeployTarget
 * with the same storage/volume picker), so this catalog never grows its own
 * runtime.
 */

import { Bot, Gamepad2, MessagesSquare, type LucideIcon } from "lucide-react";

export type AppCategory = "Messaging" | "AI" | "Game servers" | "Tools";

/** What an installed app provides, driving derived nav and which adapted
 *  dashboard is mounted. An app may declare several. */
export type AppCapability =
    | "messaging-hub"
    | "messaging-channel"
    | "ai-assistant"
    | "game-server"
    | "tool";

/** How an app is provisioned. `compose-template` runs a compose stack via Deploy;
 *  `builtin` is served by the dashboard itself (no container); `integration`
 *  defers to the integrations catalog for credential-only providers. */
export type AppInstallMethod = "compose-template" | "builtin" | "integration";

/** How an installed app's detail view is rendered. `builtin` mounts a
 *  manifest-keyed panel; `generic` reuses Deploy's logs/metrics/terminal/files
 *  panels; `iframe` embeds the app's own UI. */
export type AppDashboardKind = "builtin" | "generic" | "iframe";

/** A single environment variable the install wizard collects or defaults. */
export interface TemplateEnvVar {
    key: string;
    label: string;
    help?: string;
    /** Default value; when `secret`, prefilled values are never echoed back. */
    default?: string;
    secret?: boolean;
    required?: boolean;
}

/** A volume the app needs. The install wizard offers the same choice as Deploy:
 *  a server-local volume or a NAS-backed mount. */
export interface TemplateVolume {
    /** Stable name within the stack, e.g. "data". */
    name: string;
    /** Where it mounts inside the container, e.g. "/data". */
    mountPath: string;
    /** Human label for the storage-picker step. */
    label: string;
}

/** A container port the app exposes, used to render the app's URL/route. */
export interface TemplatePort {
    container: number;
    /** http | tcp | udp - udp matters for game servers. */
    protocol: "http" | "tcp" | "udp";
    label?: string;
}

/** The compose-template install descriptor. Either a published `image` or a
 *  `build` context (relative to the repo) is required. Consumed by the install
 *  wizard and the app-install service that drives Deploy. */
export interface AppComposeTemplate {
    image?: string;
    /** Build context path relative to the repo root, for first-party apps. */
    build?: string;
    env?: TemplateEnvVar[];
    volumes?: TemplateVolume[];
    ports?: TemplatePort[];
}

export interface AppManifest {
    /** Stable id; the InstalledApp row's catalog key and the marketplace slug. */
    id: string;
    name: string;
    category: AppCategory;
    icon: LucideIcon;
    /** One-line marketplace summary. */
    summary: string;
    /** A short paragraph shown on the install screen. */
    description: string;
    /** Vendor/docs link. */
    docsUrl?: string;
    installMethod: AppInstallMethod;
    capabilities: AppCapability[];
    dashboard: AppDashboardKind;
    /** Required when installMethod is "compose-template". */
    template?: AppComposeTemplate;
    /** Only one instance per Polaris (e.g. the messaging hub); the wizard then
     *  installs or opens the existing one instead of allowing duplicates. */
    singleton?: boolean;
    /** Declared but not yet installable - shown locked in the marketplace. */
    comingSoon?: boolean;
}

export const POLARIS_APP_CATALOG: readonly AppManifest[] = [
    {
        id: "messaging-bridge",
        name: "Messaging bridge",
        category: "Messaging",
        icon: MessagesSquare,
        summary: "Unified inbox for WhatsApp, Telegram, Discord and Slack.",
        description:
            "Runs the Polaris messaging bridge so you can read and reply to WhatsApp, Telegram, Discord and Slack conversations from one inbox, and lets AI assistants answer through the same channels. Self-hosted: the only external dependency is each platform and a phone number for WhatsApp.",
        installMethod: "compose-template",
        capabilities: ["messaging-hub"],
        dashboard: "builtin",
        singleton: true,
        template: {
            // Published by CI (.github/workflows/dashboard-publish.yml, `bridge` job)
            // from dashboard/services/messaging-bridge; the marketplace installs it as
            // a managed Deploy app rather than building from source on the host.
            image: "ghcr.io/fjrg2007/polaris-messaging-bridge:latest",
            volumes: [
                { name: "sessions", mountPath: "/app/.sessions", label: "Channel sessions" }
            ],
            ports: [{ container: 8787, protocol: "http", label: "Bridge API" }]
        }
    },
    {
        id: "minecraft",
        name: "Minecraft server",
        category: "Game servers",
        icon: Gamepad2,
        summary: "A Java Minecraft server with a live console and player list.",
        description:
            "Runs a Minecraft: Java Edition server (itzg/minecraft-server) on the server you choose, with world data on a server-local volume or a NAS. Manage it from an adapted dashboard: console, players, start/stop.",
        docsUrl: "https://docker-minecraft-server.readthedocs.io/",
        installMethod: "compose-template",
        capabilities: ["game-server"],
        dashboard: "builtin",
        template: {
            image: "itzg/minecraft-server:latest",
            env: [
                { key: "EULA", label: "Accept the Minecraft EULA", default: "TRUE", required: true },
                { key: "MEMORY", label: "Memory", help: "JVM heap, e.g. 2G.", default: "2G" }
            ],
            volumes: [{ name: "data", mountPath: "/data", label: "World data" }],
            ports: [{ container: 25565, protocol: "tcp", label: "Server port" }]
        }
    },
    {
        id: "openclaw",
        name: "OpenClaw assistant",
        category: "AI",
        icon: Bot,
        summary: "An AI assistant that answers your messaging channels.",
        description:
            "Deploys an OpenClaw AI assistant that connects to the messaging bridge and can auto-reply on any connected channel, with per-conversation handoff to a human agent.",
        installMethod: "compose-template",
        capabilities: ["ai-assistant"],
        dashboard: "builtin",
        comingSoon: true
    },
    {
        id: "hermes",
        name: "Hermes assistant",
        category: "AI",
        icon: Bot,
        summary: "A Hermes AI agent for your messaging channels.",
        description:
            "Deploys a Hermes AI agent that reuses the messaging bridge to handle conversations autonomously, escalating to a human when needed.",
        installMethod: "compose-template",
        capabilities: ["ai-assistant"],
        dashboard: "builtin",
        comingSoon: true
    }
];

/** Look up an app manifest by id. */
export function findApp(id: string): AppManifest | undefined {
    return POLARIS_APP_CATALOG.find((app) => app.id === id);
}

/** Apps that are installable now (declared, not coming soon). */
export function installableApps(): readonly AppManifest[] {
    return POLARIS_APP_CATALOG.filter((app) => !app.comingSoon);
}

/** Whether an app provides a given capability. */
export function appHasCapability(app: AppManifest, capability: AppCapability): boolean {
    return app.capabilities.includes(capability);
}

/** Whether an app can be installed today: a compose template with a runnable
 *  image (build-only apps need their image published first) and not coming soon.
 *  Pure and client-safe, so the marketplace UI and the install service agree. */
export function isInstallable(app: AppManifest): boolean {
    return !app.comingSoon && app.installMethod === "compose-template" && Boolean(app.template?.image);
}

const CATEGORY_ORDER: readonly AppCategory[] = ["Messaging", "AI", "Game servers", "Tools"];

/** Marketplace grouping, in a stable display order. */
export function appsByCategory(): ReadonlyArray<{ category: AppCategory; apps: AppManifest[] }> {
    return CATEGORY_ORDER.map((category) => ({
        category,
        apps: POLARIS_APP_CATALOG.filter((app) => app.category === category)
    })).filter((group) => group.apps.length > 0);
}

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

import { ARK_MAPS, DEFAULT_ARK_MAP } from "@/lib/apps/ark/maps";
import { Bot, Gamepad2, House, MessagesSquare, ScanFace, Video, type LucideIcon } from "lucide-react";

export type AppCategory = "Messaging" | "AI" | "Game servers" | "Home" | "Tools";

/** What an installed app provides, driving derived nav and which adapted
 *  dashboard is mounted. An app may declare several. */
export type AppCapability =
    | "messaging-hub"
    | "messaging-channel"
    | "ai-assistant"
    | "game-manager"
    | "game-server"
    | "camera-hub"
    | "home-hub"
    | "tool";

/** How an app is provisioned. `compose-template` runs a compose stack via Deploy;
 *  `builtin` is served by the dashboard itself (no container); `integration`
 *  defers to the integrations catalog for credential-only providers. */
export type AppInstallMethod = "compose-template" | "builtin" | "integration";

/** How an installed app's detail view is rendered. `builtin` mounts a
 *  manifest-keyed panel; `generic` reuses Deploy's logs/metrics/terminal/files
 *  panels; `iframe` embeds the app's own UI. */
export type AppDashboardKind = "builtin" | "generic" | "iframe";

/** One choice of a settings field rendered as a select. */
export interface TemplateEnvOption {
    value: string;
    label: string;
}

/**
 * A shape a settings value has to fit, named rather than spelled out at each
 * field so the wizard, the settings form and the save path judge it identically.
 *
 * `jvm-heap` exists because free text here is not free: the JVM accepts `8G` and
 * dies on `8GB`, and the death is a container restart loop with the reason buried
 * in a log nobody opens. A server sat down for ten days on exactly that.
 */
export type EnvValueFormat = "jvm-heap";

/** A single environment variable the install wizard collects or defaults. */
export interface TemplateEnvVar {
    key: string;
    label: string;
    help?: string;
    /** Default value; when `secret`, prefilled values are never echoed back. */
    default?: string;
    secret?: boolean;
    required?: boolean;
    /** When set, the value must be one of these and the form renders a select. */
    options?: TemplateEnvOption[];
    /** A shape the value has to fit beyond being text, for the fields where free
     *  text reaches a runtime that will reject it. */
    format?: EnvValueFormat;
    /** Minted at install time as a random secret (an app's own admin password),
     *  never shown and never asked for. Implies `secret`. */
    generated?: boolean;
    /** Editable from the installed app's settings after the install. */
    tunable?: boolean;
    /** Groups tunables under a heading in the settings form. */
    group?: string;
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
    /** The host port to publish on, when the app is reached by typing an address
     *  rather than through the proxy: a game server has to answer on the port its
     *  players' clients assume. Taken as a starting point - a second server on the
     *  same machine gets the next free one. */
    host?: number;
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
    /** A licence the operator has to accept before the app may run (Minecraft's
     *  EULA). Shown on the install button; installing is the acceptance. */
    consent?: { label: string; url: string };
    /** Only one instance per Polaris (e.g. the messaging hub); the wizard then
     *  installs or opens the existing one instead of allowing duplicates. */
    singleton?: boolean;
    /**
     * The screen this app IS, for one whose install has nothing to manage.
     *
     * Most installs are a container, and their page is the right place to land:
     * it starts, stops, redeploys and removes the thing. An app that runs nothing
     * has none of that, and its install page is a row of buttons that do not
     * apply over a status that will always read "not running" - so opening it
     * lands here instead, and so does every link that names the install.
     */
    opensAt?: string;
    /** Declared but not yet installable - shown locked in the marketplace. */
    comingSoon?: boolean;
    /** Not offered in the marketplace: it is created from inside another app that
     *  owns it (a Minecraft server is created by the Game servers app). Still a
     *  real manifest - it is what the install is made from. */
    internal?: boolean;
    /**
     * Superseded, and kept only so installs that already exist still resolve.
     *
     * An app that shipped, was installed by people, and has since been folded into
     * another one cannot simply be deleted from here: `findApp` would stop finding
     * it, and every screen that names an install would fall back to printing a
     * catalog id. So the manifest stays, is never offered again, and the install
     * is migrated to its successor the next time its owner opens the app.
     */
    legacy?: boolean;
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
        // One app for every game rather than one per game. Installing it turns the
        // Game servers page on and runs nothing; a game's own runtime arrives the
        // first time somebody creates a server of it, so a Polaris nobody plays ARK
        // on never downloads thirty gigabytes of it.
        id: "game-servers",
        name: "Game servers",
        category: "Game servers",
        icon: Gamepad2,
        opensAt: "/apps/games",
        summary: "Create and run Minecraft and ARK servers on your own machines.",
        description:
            "Install it once and create as many servers as you want, of any game Polaris knows: Minecraft for PC, phones and consoles, or ARK: Survival Evolved. Each server gets an address on your domain, a console, player moderation, its own schedule, and the memory it needs for the players you expect. Nothing is downloaded until you create a server, and only for the game that server plays.",
        installMethod: "builtin",
        capabilities: ["game-manager"],
        dashboard: "builtin",
        singleton: true,
        consent: { label: "Minecraft EULA", url: "https://www.minecraft.net/eula" }
    },
    {
        // Superseded by `game-servers`, and kept so the installs people already
        // have still resolve to a name. Migrated on sight - see `game-install`.
        id: "minecraft-manager",
        name: "Minecraft",
        legacy: true,
        opensAt: "/apps/games",
        category: "Game servers",
        icon: Gamepad2,
        summary: "Create and run as many Minecraft servers as you want.",
        description:
            "The Minecraft server manager. Superseded by Game servers, which creates servers of every game Polaris knows from one page.",
        installMethod: "builtin",
        capabilities: ["game-manager"],
        dashboard: "builtin",
        singleton: true
    },
    {
        id: "minecraft",
        name: "Minecraft (Java)",
        internal: true,
        category: "Game servers",
        icon: Gamepad2,
        summary: "A Java server for PC players, closed and protected by default.",
        description:
            "Runs a Minecraft: Java Edition server on the machine you choose, with the world on a server-local volume or a NAS. It comes closed: Mojang authentication required, whitelist enforced, command blocks off, and an anticheat and a block-history plugin already installed. Manage it from the Game servers panel: console, players, mods and settings.",
        docsUrl: "https://docker-minecraft-server.readthedocs.io/",
        installMethod: "compose-template",
        capabilities: ["game-server"],
        dashboard: "builtin",
        consent: { label: "Minecraft EULA", url: "https://www.minecraft.net/eula" },
        template: {
            image: "itzg/minecraft-server:latest",
            env: [
                // Accepted by installing (the card says so); the image refuses to boot
                // without it, so it is not a field anyone can usefully get wrong.
                { key: "EULA", label: "Minecraft EULA", default: "TRUE", required: true },
                // RCON is how the console, the player list and every moderation action
                // reach the server. The image enables it and randomizes the password
                // when unset - which a `docker exec rcon-cli` could then not use, so
                // the install mints one and passes it as the container's own.
                { key: "RCON_PASSWORD", label: "RCON password", generated: true },
                {
                    key: "TYPE",
                    label: "Server software",
                    help: "Paper runs plugins and is faster than vanilla. Fabric, Forge and NeoForge run mods.",
                    default: "PAPER",
                    options: [
                        { value: "PAPER", label: "Paper" },
                        { value: "PURPUR", label: "Purpur" },
                        { value: "SPIGOT", label: "Spigot" },
                        { value: "FABRIC", label: "Fabric" },
                        { value: "FORGE", label: "Forge" },
                        { value: "NEOFORGE", label: "NeoForge" },
                        { value: "VANILLA", label: "Vanilla" }
                    ],
                    tunable: true,
                    group: "Server"
                },
                {
                    key: "VERSION",
                    label: "Minecraft version",
                    help: "LATEST tracks the newest release. Pin one (1.21.4) to keep clients and mods matched.",
                    default: "LATEST",
                    tunable: true,
                    group: "Server"
                },
                {
                    key: "MEMORY",
                    label: "Memory",
                    help: "JVM heap, with a unit: 2G or 2048M. Leave the machine at least a gigabyte for itself.",
                    default: "2G",
                    format: "jvm-heap",
                    tunable: true,
                    group: "Server"
                },
                {
                    key: "MOTD",
                    label: "Message of the day",
                    help: "The line under the server name in the multiplayer list.",
                    default: "A Minecraft server on Polaris",
                    tunable: true,
                    group: "World"
                },
                {
                    key: "DIFFICULTY",
                    label: "Difficulty",
                    default: "easy",
                    options: [
                        { value: "peaceful", label: "Peaceful" },
                        { value: "easy", label: "Easy" },
                        { value: "normal", label: "Normal" },
                        { value: "hard", label: "Hard" }
                    ],
                    tunable: true,
                    group: "World"
                },
                {
                    key: "MODE",
                    label: "Game mode",
                    default: "survival",
                    options: [
                        { value: "survival", label: "Survival" },
                        { value: "creative", label: "Creative" },
                        { value: "adventure", label: "Adventure" },
                        { value: "spectator", label: "Spectator" }
                    ],
                    tunable: true,
                    group: "World"
                },
                {
                    key: "PVP",
                    label: "Player versus player",
                    default: "true",
                    options: [
                        { value: "true", label: "Allowed" },
                        { value: "false", label: "Blocked" }
                    ],
                    tunable: true,
                    group: "World"
                },
                {
                    key: "SEED",
                    label: "World seed",
                    help: "Blank generates a random world. Only applies before the world is created.",
                    tunable: true,
                    group: "World"
                },
                {
                    // The image installs what this lists when it boots, and removes
                    // what is taken off it - so the Mods screen edits this one value
                    // rather than pushing files into a running container.
                    //
                    // The default set is the protection a server exposed to the
                    // internet needs on day one and that nobody installs before the
                    // first griefing: an anticheat, block history to roll a raid back
                    // with, and the permission plugin both are administered through.
                    // Each carries "?" so a Minecraft release they have no build for
                    // yet warns instead of stopping the server from booting.
                    //
                    // GrimAC also says which builds count, because it publishes
                    // nothing else: every one of its Modrinth builds is tagged
                    // alpha, and the image takes finished releases by default - so
                    // the anticheat every server was supposed to get was quietly
                    // never installed on any of them.
                    key: "MODRINTH_PROJECTS",
                    label: "Mods and plugins",
                    help: "Modrinth projects to install, comma separated. Managed from the Mods tab.",
                    default: "grimac?:alpha,coreprotect?,luckperms?",
                    tunable: true,
                    group: "Mods"
                },
                {
                    key: "MODRINTH_DOWNLOAD_DEPENDENCIES",
                    label: "Dependencies",
                    help: "Whether a mod's own dependencies are installed with it.",
                    default: "required",
                    options: [
                        { value: "required", label: "Required only" },
                        { value: "optional", label: "Required and optional" },
                        { value: "none", label: "None" }
                    ],
                    tunable: true,
                    group: "Mods"
                },
                {
                    key: "RESOURCE_PACK",
                    label: "Resource pack",
                    help: "A direct link to the pack's zip. Players are offered it when they join.",
                    tunable: true,
                    group: "World"
                },
                {
                    key: "RESOURCE_PACK_SHA1",
                    label: "Resource pack checksum",
                    help: "The pack's SHA-1. Without it clients re-download the pack every time.",
                    tunable: true,
                    group: "World"
                },
                {
                    key: "RESOURCE_PACK_ENFORCE",
                    label: "Require the resource pack",
                    help: "On disconnects players who decline it.",
                    default: "false",
                    options: [
                        { value: "false", label: "Optional" },
                        { value: "true", label: "Required" }
                    ],
                    tunable: true,
                    group: "World"
                },
                {
                    key: "MAX_PLAYERS",
                    label: "Player slots",
                    default: "20",
                    tunable: true,
                    group: "Players"
                },
                {
                    key: "VIEW_DISTANCE",
                    label: "View distance",
                    help: "Chunks sent to each player. Lower it if the server struggles.",
                    default: "10",
                    tunable: true,
                    group: "Players"
                },
                {
                    key: "ONLINE_MODE",
                    label: "Mojang authentication",
                    help: "Off lets cracked clients in, and anyone can claim any username.",
                    default: "true",
                    options: [
                        { value: "true", label: "Required" },
                        { value: "false", label: "Not required" }
                    ],
                    tunable: true,
                    group: "Players"
                },
                {
                    // A new server is reachable the moment it boots, and an open one
                    // is found by scanners within the hour. It starts closed: add
                    // yourself from the Players screen, or turn this off.
                    key: "ENABLE_WHITELIST",
                    label: "Whitelist",
                    help: "On means only players you add can join. Add yourself from Players.",
                    default: "true",
                    options: [
                        { value: "true", label: "Enforced" },
                        { value: "false", label: "Anyone may join" }
                    ],
                    tunable: true,
                    group: "Players"
                },
                {
                    // The players the server boots already whitelisted, so it is
                    // never created with the whitelist on and nobody on it. Written
                    // by the create flow from the operator's own username; the image
                    // merges it into whatever whitelist.json already holds, so
                    // players added later survive a restart. Not tunable: the list
                    // is managed from Players and the firewall, not as raw text.
                    key: "WHITELIST",
                    label: "Whitelisted players"
                },
                {
                    // Same, for who administers it. A server whose creator is not an
                    // operator cannot be moderated from inside the game.
                    key: "OPS",
                    label: "Operators"
                },
                {
                    // Applies a whitelist change to whoever is already connected
                    // rather than only to the next person who joins.
                    key: "ENFORCE_WHITELIST",
                    label: "Apply the whitelist immediately",
                    default: "true",
                    options: [
                        { value: "true", label: "Yes" },
                        { value: "false", label: "On next join" }
                    ],
                    tunable: true,
                    group: "Players"
                },
                {
                    // A command block is an in-game way to run server commands, and
                    // the usual route from "a griefer got in" to "the server is gone".
                    key: "ENABLE_COMMAND_BLOCK",
                    label: "Command blocks",
                    help: "Off keeps players from running server commands from inside the world.",
                    default: "false",
                    options: [
                        { value: "false", label: "Blocked" },
                        { value: "true", label: "Allowed" }
                    ],
                    tunable: true,
                    group: "Security"
                },
                {
                    key: "ENFORCE_SECURE_PROFILE",
                    label: "Signed chat profiles",
                    help: "On rejects clients that cannot prove who they are.",
                    default: "true",
                    options: [
                        { value: "true", label: "Required" },
                        { value: "false", label: "Not required" }
                    ],
                    tunable: true,
                    group: "Security"
                },
                {
                    key: "SPAWN_PROTECTION",
                    label: "Spawn protection",
                    help: "Blocks in this radius of spawn can only be changed by operators. 0 disables it.",
                    default: "16",
                    tunable: true,
                    group: "Security"
                }
            ],
            volumes: [{ name: "data", mountPath: "/data", label: "World data" }],
            ports: [{ container: 25565, protocol: "tcp", host: 25565, label: "Server port" }]
        }
    },
    {
        id: "minecraft-bedrock",
        name: "Minecraft (Bedrock)",
        internal: true,
        category: "Game servers",
        icon: Gamepad2,
        summary: "A Bedrock server for phones, consoles and Windows.",
        description:
            "Runs a Minecraft: Bedrock Edition server, the one phones, consoles, tablets and the Windows app connect to. Managed from the same panel as a Java server: console, players, settings. Bedrock has no RCON, so commands are sent to the server's console and the player list is read from it.",
        docsUrl: "https://github.com/itzg/docker-minecraft-bedrock-server",
        installMethod: "compose-template",
        capabilities: ["game-server"],
        dashboard: "builtin",
        consent: { label: "Minecraft EULA", url: "https://www.minecraft.net/eula" },
        template: {
            image: "itzg/minecraft-bedrock-server:latest",
            env: [
                { key: "EULA", label: "Minecraft EULA", default: "TRUE", required: true },
                {
                    key: "VERSION",
                    label: "Bedrock version",
                    help: "LATEST tracks the newest release.",
                    default: "LATEST",
                    tunable: true,
                    group: "Server"
                },
                {
                    key: "SERVER_NAME",
                    label: "Server name",
                    help: "Shown in the friends and servers list.",
                    default: "A Minecraft server on Polaris",
                    tunable: true,
                    group: "World"
                },
                {
                    key: "DIFFICULTY",
                    label: "Difficulty",
                    default: "easy",
                    options: [
                        { value: "peaceful", label: "Peaceful" },
                        { value: "easy", label: "Easy" },
                        { value: "normal", label: "Normal" },
                        { value: "hard", label: "Hard" }
                    ],
                    tunable: true,
                    group: "World"
                },
                {
                    key: "GAMEMODE",
                    label: "Game mode",
                    default: "survival",
                    options: [
                        { value: "survival", label: "Survival" },
                        { value: "creative", label: "Creative" },
                        { value: "adventure", label: "Adventure" }
                    ],
                    tunable: true,
                    group: "World"
                },
                {
                    key: "LEVEL_SEED",
                    label: "World seed",
                    help: "Blank generates a random world. Only applies before the world is created.",
                    tunable: true,
                    group: "World"
                },
                {
                    key: "MAX_PLAYERS",
                    label: "Player slots",
                    default: "10",
                    tunable: true,
                    group: "Players"
                },
                {
                    key: "VIEW_DISTANCE",
                    label: "View distance",
                    default: "10",
                    tunable: true,
                    group: "Players"
                },
                {
                    // Bedrock's whitelist. On by default for the same reason Java's
                    // is: a server nobody was let into cannot be griefed.
                    key: "ALLOW_LIST",
                    label: "Allow list",
                    help: "On means only players on the allow list can join.",
                    default: "true",
                    options: [
                        { value: "true", label: "Enforced" },
                        { value: "false", label: "Anyone may join" }
                    ],
                    tunable: true,
                    group: "Players"
                },
                {
                    // Gamertags the server boots with as operators. Bedrock resolves
                    // each to an XUID at startup, which is also the only way Polaris
                    // can name a Bedrock player before they have ever connected.
                    key: "OPS",
                    label: "Operators"
                },
                {
                    key: "ONLINE_MODE",
                    label: "Xbox Live authentication",
                    help: "Off lets unauthenticated clients in, and anyone can claim any name.",
                    default: "true",
                    options: [
                        { value: "true", label: "Required" },
                        { value: "false", label: "Not required" }
                    ],
                    tunable: true,
                    group: "Players"
                }
            ],
            volumes: [{ name: "data", mountPath: "/data", label: "World data" }],
            // Bedrock speaks UDP; published as TCP it answers nothing at all.
            ports: [{ container: 19132, protocol: "udp", host: 19132, label: "Server port" }]
        }
    },
    {
        // Superseded by `game-servers`, on the same terms as the Minecraft one.
        id: "ark-manager",
        name: "ARK: Survival Evolved",
        legacy: true,
        category: "Game servers",
        icon: Gamepad2,
        summary: "Create and run as many ARK servers as you want.",
        description:
            "The ARK: Survival Evolved server manager. Superseded by Game servers, which creates servers of every game Polaris knows from one page.",
        installMethod: "builtin",
        capabilities: ["game-manager"],
        dashboard: "builtin",
        singleton: true
    },
    {
        id: "ark",
        name: "ARK: Survival Evolved",
        internal: true,
        category: "Game servers",
        icon: Gamepad2,
        summary: "An ARK server for PC players, closed to everyone you have not added.",
        description:
            "Runs an ARK: Survival Evolved dedicated server on the machine you choose, with the world on a server-local volume or a NAS. It comes closed: a join password only you have, BattlEye on, an admin password Polaris mints and keeps, and only the players you add allowed in. Manage it from the Game servers panel: console, players, mods and settings.",
        docsUrl: "https://github.com/Hermsi1337/docker-ark-server",
        installMethod: "compose-template",
        capabilities: ["game-server"],
        dashboard: "builtin",
        template: {
            image: "hermsi/ark-server:latest",
            env: [
                {
                    // The in-game admin console and RCON share this one password,
                    // and the image ships a default that is printed in its README.
                    // Minted per server by the create flow and shown only to whoever
                    // can already read the server's secrets.
                    //
                    // Deliberately not `generated`: that mints 48 hex characters,
                    // which is right for a password nothing human ever types and
                    // wrong for this one - ARK refuses it at the `enablecheats`
                    // prompt as too long, so the server's own admin cannot get in.
                    // It is minted to the same shape as the join password instead.
                    key: "ADMIN_PASSWORD",
                    label: "Admin password",
                    help: "What you type after enablecheats in game. Change it from the server's Access screen.",
                    secret: true,
                    required: true
                },
                {
                    // The other half of the same problem: the image's own default
                    // join password is public. Always written by the create flow,
                    // required so an empty one is refused rather than dropped back
                    // onto the image's. Not tunable - a secret read back masked and
                    // saved again would overwrite the real one with a blank.
                    key: "SERVER_PASSWORD",
                    label: "Join password",
                    help: "Players type this when they connect. Change it from the server's Access screen.",
                    secret: true,
                    required: true
                },
                {
                    key: "SESSION_NAME",
                    label: "Server name",
                    help: "The name shown in the in-game server browser.",
                    default: "An ARK server on Polaris",
                    tunable: true,
                    group: "World"
                },
                {
                    key: "SERVER_MAP",
                    label: "Map",
                    help: "Changing it loads that map's own world. The old one is kept and comes back if you switch back.",
                    default: DEFAULT_ARK_MAP,
                    options: ARK_MAPS.map((map) => ({
                        value: map.value,
                        label: map.requires === "base" ? map.label : `${map.label} (${map.requires === "paid" ? "needs the DLC" : "a separate free download"})`
                    })),
                    tunable: true,
                    group: "World"
                },
                {
                    key: "SERVER_MAP_MOD_ID",
                    label: "Modded map id",
                    help: "The Steam Workshop id of a custom map. Leave blank for the maps that ship with the game.",
                    tunable: true,
                    group: "Mods"
                },
                {
                    key: "GAME_MOD_IDS",
                    label: "Mods",
                    help: "Steam Workshop ids, comma separated. Installed on the next start.",
                    tunable: true,
                    group: "Mods"
                },
                {
                    key: "MAX_PLAYERS",
                    label: "Player slots",
                    default: "20",
                    tunable: true,
                    group: "Players"
                },
                {
                    // Epic clients as well as Steam ones. Off by default because it
                    // widens who can reach the server, and a server is easier to
                    // open later than it is to un-open.
                    key: "ENABLE_CROSSPLAY",
                    label: "Epic Games players",
                    help: "On lets Epic clients join as well as Steam ones.",
                    default: "false",
                    options: [
                        { value: "false", label: "Steam only" },
                        { value: "true", label: "Steam and Epic" }
                    ],
                    tunable: true,
                    group: "Players"
                },
                {
                    key: "UPDATE_ON_START",
                    label: "Update before starting",
                    help: "Keeps the server and its mods current. Off starts faster and drifts behind the clients.",
                    default: "true",
                    options: [
                        { value: "true", label: "Yes" },
                        { value: "false", label: "No" }
                    ],
                    tunable: true,
                    group: "Server"
                },
                {
                    key: "VALIDATE_ON_START",
                    label: "Verify the files",
                    help: "Has Steam repair a damaged install on each start. Noticeably slower.",
                    default: "false",
                    options: [
                        { value: "false", label: "No" },
                        { value: "true", label: "Yes" }
                    ],
                    tunable: true,
                    group: "Server"
                },
                {
                    key: "PRE_UPDATE_BACKUP",
                    label: "Back up before updating",
                    default: "true",
                    options: [
                        { value: "true", label: "Yes" },
                        { value: "false", label: "No" }
                    ],
                    tunable: true,
                    group: "Server"
                },
                {
                    key: "BACKUP_ON_STOP",
                    label: "Back up when stopping",
                    default: "true",
                    options: [
                        { value: "true", label: "Yes" },
                        { value: "false", label: "No" }
                    ],
                    tunable: true,
                    group: "Server"
                },
                {
                    key: "WARN_ON_STOP",
                    label: "Warn players before stopping",
                    default: "true",
                    options: [
                        { value: "true", label: "Yes" },
                        { value: "false", label: "No" }
                    ],
                    tunable: true,
                    group: "Server"
                },
                {
                    // BattlEye is the only anticheat an ARK server has. It stays on
                    // unless somebody deliberately turns it off, and the label says
                    // which way round that is.
                    key: "DISABLE_BATTLEYE",
                    label: "BattlEye anticheat",
                    help: "Off means clients are not checked at all.",
                    default: "false",
                    options: [
                        { value: "false", label: "On" },
                        { value: "true", label: "Off" }
                    ],
                    tunable: true,
                    group: "Security"
                },
                {
                    // Carries `-exclusivejoin`, which is what makes the server let in
                    // only the players Polaris added. Deliberately not tunable: it is
                    // one string holding several flags, and a free-text edit that
                    // dropped that one word would reopen the server silently. The
                    // Security screen owns it.
                    key: "ARK_EXTRA_OPTS",
                    label: "Launch options"
                },
                // The ports the server binds inside its container. Set by the create
                // flow to the ones Polaris published for it, because ARK's raw socket
                // has to be exactly one above its game port on the player's side too -
                // so the two cannot be mapped independently. Not tunable: changing one
                // without republishing is a server nobody can reach.
                { key: "GAME_CLIENT_PORT", label: "Game port" },
                { key: "UDP_SOCKET_PORT", label: "Raw socket port" },
                { key: "SERVER_LIST_PORT", label: "Server list port" }
            ],
            volumes: [{ name: "data", mountPath: "/app", label: "Server files and world" }],
            // ARK speaks UDP on all three. RCON (27020/tcp) is deliberately absent:
            // commands are run inside the container, so nothing has to be exposed for
            // the console and the player list to work.
            ports: [
                { container: 7777, protocol: "udp", host: 7777, label: "Game port" },
                { container: 7778, protocol: "udp", host: 7778, label: "Raw socket" },
                { container: 27015, protocol: "udp", host: 27015, label: "Server list" }
            ]
        }
    },
    {
        // The house, installed once for the whole Polaris rather than per person:
        // there is one of it, and everybody who lives there is looking at the same
        // cameras. Installing runs nothing - the media relay arrives with the first
        // camera, and only on the machine that was picked for it.
        id: "home",
        name: "Places",
        category: "Home",
        icon: House,
        opensAt: "/places",
        summary: "Your places, and the cameras watching them, on your own machines.",
        description:
            "A house, an office, a workshop - each with its own cameras. Watch them live, keep what matters, and get told when something happens. Polaris pulls each camera once and shows it to everybody watching, so the camera never runs out of connections. Detection is yours to choose per camera - the camera's own alerts, movement, people, or faces - along with where it runs and how often, so a house full of cameras does not have to cost a machine.",
        installMethod: "builtin",
        capabilities: ["home-hub"],
        dashboard: "builtin",
        singleton: true
    },
    {
        // The relay every camera is watched through. Never offered on its own: it is
        // installed by Home the first time a camera is added, on the machine that
        // camera was told to use, and it is useless without one.
        id: "camera-hub",
        name: "Camera relay",
        internal: true,
        category: "Home",
        icon: Video,
        summary: "Pulls each camera once and streams it to everybody watching.",
        description:
            "The media relay behind Home. It holds one connection per camera and re-serves it to every viewer without re-encoding, so a camera that allows a single stream can still be watched by several people at once, and the machine it runs on barely notices.",
        docsUrl: "https://github.com/AlexxIT/go2rtc",
        installMethod: "compose-template",
        capabilities: ["camera-hub"],
        dashboard: "generic",
        template: {
            // Published by CI (.github/workflows/dashboard-publish.yml, `relay`
            // job) from dashboard/services/camera-relay: go2rtc with credentials
            // on its API, which the stock image has no way to arrive with.
            image: "ghcr.io/fjrg2007/polaris-camera-relay:latest",
            build: "dashboard/services/camera-relay",
            env: [
                { key: "RELAY_USERNAME", label: "API account", default: "polaris" },
                // Minted at install and never shown: nobody types it, Polaris is
                // the only thing that ever calls this API, and the relay refuses
                // to start without it rather than coming up open.
                { key: "RELAY_PASSWORD", label: "API password", generated: true }
            ],
            volumes: [{ name: "config", mountPath: "/config", label: "Relay configuration" }],
            ports: [{ container: 1984, protocol: "http", label: "Relay API" }]
        }
    },
    {
        // The machine that does the looking. Never offered on its own: Home puts
        // one on whichever server a camera's detection was pointed at, and it is
        // useless without a camera to watch.
        id: "vision-worker",
        name: "Vision worker",
        internal: true,
        category: "Home",
        icon: ScanFace,
        summary: "Watches the small stream for movement, so nothing else has to.",
        description:
            "The part of Home that looks at pixels. It reads the small stream from the relay - never the camera - decides that something moved, and only then does anything more expensive. It sits idle the rest of the time, and it runs on the machine you chose rather than on the one Polaris is on.",
        installMethod: "compose-template",
        capabilities: ["tool"],
        dashboard: "generic",
        template: {
            image: "ghcr.io/fjrg2007/polaris-vision:latest",
            build: "dashboard/services/vision",
            env: [
                { key: "POLARIS_URL", label: "Where Polaris is", required: true },
                // Minted at install. The worker presents it to ask what to watch
                // and to report what it saw; nobody types it.
                { key: "WORKER_KEY", label: "Worker key", generated: true }
            ]
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

/** Whether an app is one the marketplace still offers at all. Everything else
 *  here - what it is called, how its dashboard is drawn - stays true of an app
 *  that is only offered from inside another one, or is no longer offered. */
export function isOffered(app: AppManifest): boolean {
    return !app.internal && !app.legacy;
}

/** Apps that are installable now (declared, not coming soon). */
export function installableApps(): readonly AppManifest[] {
    return POLARIS_APP_CATALOG.filter((app) => !app.comingSoon && isOffered(app));
}

/** Whether an app provides a given capability. */
export function appHasCapability(app: AppManifest, capability: AppCapability): boolean {
    return app.capabilities.includes(capability);
}

/** Whether an app can be installed today: a compose template with a runnable
 *  image (build-only apps need their image published first) and not coming soon.
 *  Pure and client-safe, so the marketplace UI and the install service agree. */
export function isInstallable(app: AppManifest): boolean {
    if (app.comingSoon || app.legacy) return false;
    // A builtin app has nothing to run: installing it records that this Polaris
    // has it, and the app itself is the dashboard.
    if (app.installMethod === "builtin") return true;
    return app.installMethod === "compose-template" && Boolean(app.template?.image);
}

/** The env vars an operator fills in: everything the manifest declares except the
 *  ones the install mints itself and the ones installing already answers. */
export function promptedEnvVars(app: AppManifest): readonly TemplateEnvVar[] {
    return (app.template?.env ?? []).filter((field) => !field.generated && !isConsentField(app, field));
}

/** The env vars an installed app exposes as settings, in manifest order. */
export function tunableEnvVars(app: AppManifest): readonly TemplateEnvVar[] {
    return (app.template?.env ?? []).filter((field) => field.tunable);
}

/** What people actually type for a heap: `8G`, `8GB`, `8 gb`, `2048M`. A unit is
 *  required - a bare number means bytes to the JVM, which is nobody's intent and
 *  not a thing to guess at. */
const JVM_HEAP = /^(\d{1,6})\s*(g|gb|m|mb|k|kb)$/i;

/**
 * The value as it will be stored, which is the only one worth validating.
 *
 * Normalizing first is the point: `8GB` is a reasonable thing to type and an
 * invalid heap, so it is corrected into `8G` rather than refused. Anything that
 * cannot be read as a heap at all is left exactly as typed, for the check below
 * to reject - a normalizer that patches a value into validity is a check that
 * cannot fail.
 */
export function normalizeEnvValue(field: TemplateEnvVar, value: string): string {
    const trimmed = value.trim();
    if (field.format !== "jvm-heap") return trimmed;
    const heap = JVM_HEAP.exec(trimmed);
    if (!heap) return trimmed;
    return `${heap[1]}${heap[2]![0]!.toUpperCase()}`;
}

/** What to say when a value does not fit the field's format. Lives here so the
 *  refusal names the shape the same way wherever the value was typed. */
export function envFormatHint(field: TemplateEnvVar): string {
    if (field.format === "jvm-heap") return "give a size with a unit, like 2G or 2048M";
    return "that is not a value this setting accepts";
}

/** Whether a value is one the manifest allows for this field. A field with
 *  options accepts only those, one with a format has to fit it, and everything
 *  else is bounded free text. Judge the normalized value - see above. */
export function isAllowedEnvValue(field: TemplateEnvVar, value: string): boolean {
    if (field.required && value.trim().length === 0) return false;
    if (field.options) return field.options.some((option) => option.value === value);
    if (field.format === "jvm-heap") return /^\d{1,6}[GMK]$/.test(value);
    return value.length <= 4096;
}

/** The consent checkbox stands in for this field, so the form never asks for it. */
function isConsentField(app: AppManifest, field: TemplateEnvVar): boolean {
    return Boolean(app.consent) && field.key === "EULA";
}

const CATEGORY_ORDER: readonly AppCategory[] = ["Messaging", "AI", "Game servers", "Home", "Tools"];

/** Marketplace grouping, in a stable display order. */
export function appsByCategory(): ReadonlyArray<{ category: AppCategory; apps: AppManifest[] }> {
    return CATEGORY_ORDER.map((category) => ({
        category,
        apps: POLARIS_APP_CATALOG.filter((app) => app.category === category && isOffered(app))
    })).filter((group) => group.apps.length > 0);
}

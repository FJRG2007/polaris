/**
 * Mods that announce themselves to every player who joins - a "thanks for
 * using", a tip, the address of the mod author's own server - and the setting in
 * each one's config that stops it.
 *
 * Polaris turns them off on its own when it finds such a mod on a server: a line
 * nobody on the server wrote, pointing players at another server, is not
 * something an operator should have to discover and then hunt down in a config
 * file. The operator can let one back on from the Moderation tab, and that is
 * remembered per server.
 *
 * Each entry is sourced from the mod's own config definition (the link beside
 * it), never guessed: a key the mod does not read changes nothing, and a key
 * written with the wrong type is "corrected" by the mod back to its default. An
 * entry only covers the releases whose source was read.
 *
 * Why a config change rather than a chat filter: SecurityCraft's line is not even
 * sent by the server. The player's own game writes it into their chat when they
 * join, reading the server's config that NeoForge hands every client on joining.
 * Nothing on the server ever sees that line to stop it; the setting is the only
 * way to.
 *
 * Pure.
 */

import { z } from "zod";

/** The install config key the operator's choices live under. */
export const ANNOUNCEMENTS_KEY = "modAnnouncements";

/** Where a server config lives relative to the server's folder. On NeoForge
 *  1.21 a SERVER config is read from `config/`, unless the world carries its own
 *  copy in `<world>/serverconfig/`, which then wins - so both are set. */
export type ConfigPlace = "config" | "world-serverconfig";

export interface Announcer {
    /** Stable id, stored in the operator's choices. */
    readonly id: string;
    /** The mod's own name, shown as it is: a product name is not translated. */
    readonly name: string;
    /** A jar in the mods folder that is this mod, matched on its file name. */
    readonly jar: RegExp;
    /** The config file's name, and the folders it is read from. */
    readonly file: string;
    readonly places: readonly ConfigPlace[];
    /** The TOML table the key sits in, part by part, unquoted; empty for the
     *  top level. */
    readonly table: readonly string[];
    readonly key: string;
    /** The value that stops the message, and the mod's own default. */
    readonly blocked: string;
    readonly allowed: string;
    /**
     * When a change reaches the players. "join": the server reloads the file the
     * moment it changes and hands it to each player as they join, so the next
     * join is already quiet and nobody has to be disconnected. "restart": read
     * once, when the server starts.
     */
    readonly applies: "join" | "restart";
    /** Where the key and its meaning were read. */
    readonly source: string;
}

/** Where each entry's key was read, on GitHub. */
const GITHUB = "https://github.com";

/**
 * The known ones. Every one is a TOML config the server reads, so an edit on the
 * server stops the message for every player. Mods whose message is shown by a
 * client-side setting (Advent of Ascension, DivineRPG, JourneyMap, CyclopsCore)
 * are left out: nothing on the server can switch those off. So are the ones
 * kept in JSON (Create Better Villagers, World First Join Message, Underground
 * Village) and Create: Fuel Motor, whose config folder has spaces in its name:
 * this only edits TOML, in files at plain paths.
 *
 * SecurityCraft: `ConfigHandler.Server.disableThanksMessage`, a SERVER config
 * (top level). Its client shows "Thanks for using SecurityCraft ... Tip: ..." on
 * joining - among the tips, "The official SecurityCraft Minecraft server is back!
 * Join using this IP" - unless the server's copy says true. NeoForge's loader
 * watches the file and reloads it on a change, and sends its bytes to each
 * client as that client joins (`ConfigTracker.openConfig`,
 * `ConfigSync.syncConfigs`), so it applies from the next join on. Forge 1.20.1
 * reads SERVER configs only from the world's `serverconfig`, which is why both
 * places are set.
 *
 * The rest are read by the mod each time a player logs in (or, for The Aether
 * II, enters its dimension), so they too apply from the next time without a
 * restart. The Aether and Vampirism set their own key to false once they have
 * sent the message.
 */
export const ANNOUNCERS: readonly Announcer[] = [
    {
        id: "securitycraft",
        name: "SecurityCraft",
        jar: /securitycraft/i,
        file: "securitycraft-server.toml",
        places: ["config", "world-serverconfig"],
        table: [],
        key: "disable_thanks_message",
        blocked: "true",
        allowed: "false",
        applies: "join",
        source: `${GITHUB}/Geforce132/SecurityCraft/blob/eol/1.21.4/src/main/java/net/geforcemods/securitycraft/ConfigHandler.java`
    },
    {
        id: "aether",
        name: "The Aether",
        jar: /^(?!.*aether[-_ ]?ii)(?!.*deep[-_ ]?aether).*\baether\b/i,
        file: "aether-common.toml",
        places: ["config"],
        table: ["Gameplay"],
        key: "Show Patreon message",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/The-Aether-Team/The-Aether/blob/1.21.1-develop/src/main/java/com/aetherteam/aether/AetherConfig.java`
    },
    {
        id: "aether_ii",
        name: "The Aether II",
        jar: /aether[-_ ]?ii\b/i,
        file: "aether_ii-common.toml",
        places: ["config"],
        table: ["Gameplay"],
        key: "Alpha Message",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/The-Aether-Team/The-Aether-II/blob/26.1-develop/src/main/java/com/aetherteam/aetherii/AetherIIConfig.java`
    },
    {
        id: "vampirism",
        name: "Vampirism",
        jar: /\bvampirism\b(?![-_ ]?integrations)/i,
        file: "vampirism-server.toml",
        places: ["config", "world-serverconfig"],
        table: ["server", "internal"],
        key: "infoAboutGuideAPI",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/TeamLapen/Vampirism/blob/version/1.21/latest/src/main/java/de/teamlapen/vampirism/config/ServerConfig.java`
    },
    {
        id: "jeg",
        name: "Just Enough Guns",
        jar: /just[-_ ]?enough[-_ ]?guns|^jeg[-_]/i,
        file: "jeg-common.toml",
        places: ["config"],
        table: ["common", "network"],
        key: "firstJoinMessages",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/MigaMiDev/Just-Enough-Guns/blob/master/src/main/java/ttv/migami/jeg/Config.java`
    },
    {
        id: "urushi",
        name: "Urushi",
        jar: /\burushi\b/i,
        file: "urushi.toml",
        places: ["config"],
        table: ["world settings"],
        key: "version message (true/false)",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/iwaliner/Urushi-MOD-1.20.1/blob/main/src/main/java/com/iwaliner/urushi/ConfigUrushi.java`
    },
    {
        id: "create_extra_casing",
        name: "Create: Extra Casing",
        jar: /create[-_ ]?extra[-_ ]?casing/i,
        file: "create_extra_casing-common.toml",
        places: ["config"],
        table: ["General"],
        key: "messageEnabled",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/Reggarfgod/create_extra_casing/blob/NeoForge-1.21.1-6.0.6/src/main/java/com/reggarf/mods/create_extra_casing/config/CECCommon.java`
    },
    {
        id: "create_better_motors",
        name: "Create: Better Motors",
        jar: /create[-_ ]?better[-_ ]?motors/i,
        file: "create_better_motors-common.toml",
        places: ["config"],
        table: ["Messages"],
        key: "messages_enabled",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/Reggarfgod/Create_Better_Motors/blob/Neoforge-1.21.1-6.0.x/src/main/java/com/reggarf/mods/create_better_motors/config/CommonConfig.java`
    },
    {
        id: "ae_better_villagers",
        name: "AE2 Better Villagers",
        jar: /ae2?[-_ ]?better[-_ ]?villagers/i,
        file: "ae_better_villagers-common.toml",
        places: ["config"],
        table: ["welcome_message"],
        key: "enabled",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/Reggarfgod/AE2-Better-Villagers/blob/master/src/main/java/com/reggarf/mods/aebettervillagers/join/FirstJoinMessageHandler.java`
    },
    {
        id: "logisticsnetworks",
        name: "Logistics Networks",
        jar: /logistics[-_ ]?networks?/i,
        file: "logistics-network/common.toml",
        places: ["config"],
        table: [],
        key: "juneAwarenessMessage",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/Almana-mc/LogisticsNetworks/blob/26.1.2/src/main/java/me/almana/logisticsnetworks/Config.java`
    },
    {
        id: "smartbackpacks",
        name: "Smart Backpacks",
        jar: /smart[-_ ]?backpacks/i,
        file: "smartbackpacksconfig.toml",
        places: ["config"],
        table: ["wearing"],
        key: "showWelcomeMessage",
        blocked: "false",
        allowed: "true",
        applies: "join",
        source: `${GITHUB}/SmartStreamLabs/SmartBackpacks/blob/main/src/main/java/com/teamsmartstreamlabs/smartbackpacks/SmartBackpacksConfig.java`
    }
];

/**
 * A data pack shipped inside a mod jar that announces itself from a function the
 * game runs on every data reload - `tellraw @a` from its load function - so the
 * whole server reads it each time the data is reloaded, which includes every
 * time a data pack is switched on or off (Polaris's own events pack among them).
 *
 * There is no setting to change. What stops it is a function of the same name in
 * a pack ranked above the mod's: Polaris's own `polaris-quiet` pack, holding an
 * empty function at that address. A data pack's function is replaced whole by a
 * higher pack's, so this only lists functions that do nothing but announce -
 * read in the jar - never one that also sets something up.
 */
export interface PackAnnouncer {
    readonly id: string;
    readonly name: string;
    readonly jar: RegExp;
    /** The functions that only announce, as `namespace:path`. */
    readonly functions: readonly string[];
    /** Where they were read. */
    readonly source: string;
}

/**
 * Dynamic Lights by CreepermeYT: `config/load` is a single `tellraw @a` ("-> LOADED:
 * < Dynamic Lights By CreepermeYT > v1.4.6"), run from `internal/load` on every
 * reload. Read in `dynamic-lights-creepermeyt-v1.4.6-mc1.17.x-26.3.jar`, where it
 * is the same one line in the base pack and in every overlay that carries it.
 */
export const PACK_ANNOUNCERS: readonly PackAnnouncer[] = [
    {
        id: "dynamic_lights_creepermeyt",
        name: "Dynamic Lights",
        jar: /dynamic[-_]?lights[-_]?creepermeyt/i,
        functions: ["dynamic_lights_by_creepermeyt:config/load"],
        source: `${GITHUB}/CreepermeYT/Dynamic-Lights-By-CreepermeYT`
    }
];

/** The folder of Polaris's quieting pack in a world's `datapacks`, and the id the
 *  game knows it by. */
export const QUIET_PACK_DIR = "polaris-quiet";
export const QUIET_PACK_ID = `file/${QUIET_PACK_DIR}`;

/** Whether an id is one the operator can choose about, of either kind. */
export function isAnnouncerId(id: string): boolean {
    return ANNOUNCERS.some((one) => one.id === id) || PACK_ANNOUNCERS.some((one) => one.id === id);
}

/** The pack announcers whose jar is in the mods folder. */
export function installedPackAnnouncers(modFiles: readonly string[]): PackAnnouncer[] {
    const jars = modFiles.filter((file) => /\.jar$/i.test(file));
    return PACK_ANNOUNCERS.filter((one) => jars.some((file) => one.jar.test(file)));
}

/**
 * The quieting pack's files, relative to its folder: its description and an
 * empty function for every announcing function of each blocked pack. Written
 * under both `function` (1.21 on) and `functions` (before it), since one pack
 * serves every release. A format range as wide as the events pack's, so no
 * release turns it away.
 */
export function quietPackFiles(blocked: readonly PackAnnouncer[]): Map<string, string> {
    const files = new Map<string, string>();
    files.set(
        "pack.mcmeta",
        `${JSON.stringify({
            pack: {
                description: "Polaris: quiets data pack announcements",
                pack_format: 4,
                supported_formats: [4, 1000],
                min_format: 4,
                max_format: 1000
            }
        })}\n`
    );
    for (const announcer of blocked) {
        for (const name of announcer.functions) {
            const [namespace, path] = name.split(":");
            for (const folder of ["function", "functions"]) {
                files.set(
                    `data/${namespace}/${folder}/${path}.mcfunction`,
                    "# Quieted by Polaris (Moderation > Mod announcements).\n"
                );
            }
        }
    }
    return files;
}

/** The operator's choices on one server: the mods whose announcements are let
 *  through. Everything else found is blocked. */
export const announcementsSchema = z.object({
    allowed: z.array(z.string().max(64)).max(64).default([])
});

export type AnnouncementChoices = z.infer<typeof announcementsSchema>;

/** The choices out of the install config, whatever was stored there. */
export function readAnnouncementChoices(config: Record<string, unknown>): AnnouncementChoices {
    const parsed = announcementsSchema.safeParse(config[ANNOUNCEMENTS_KEY] ?? {});
    return parsed.success
        ? { allowed: parsed.data.allowed.filter(isAnnouncerId) }
        : { allowed: [] };
}

/** The choices with one mod let through or blocked again. */
export function withChoice(
    choices: AnnouncementChoices,
    id: string,
    allow: boolean
): AnnouncementChoices {
    const others = choices.allowed.filter((one) => one !== id);
    return { allowed: allow ? [...others, id] : others };
}

/** The announcers whose jar is in the mods folder, from its file names. */
export function installedAnnouncers(modFiles: readonly string[]): Announcer[] {
    const jars = modFiles.filter((file) => /\.jar$/i.test(file));
    return ANNOUNCERS.filter((one) => jars.some((file) => one.jar.test(file)));
}

/** Where the server reads one announcer's config from, as absolute paths in the
 *  container. `level` is the world folder's name (`level-name`). */
export function configPaths(announcer: Announcer, dataDir: string, level: string): string[] {
    return announcer.places.map((place) =>
        place === "config"
            ? `${dataDir}/config/${announcer.file}`
            : `${dataDir}/${level}/serverconfig/${announcer.file}`
    );
}

/** The value one announcer's key should hold on this server. */
export function wantedValue(announcer: Announcer, choices: AnnouncementChoices): string {
    return choices.allowed.includes(announcer.id) ? announcer.allowed : announcer.blocked;
}

/**
 * Reading and changing the rules an ARK server is played under.
 *
 * Two files, and they are not read for the same reason. The instance config is
 * what Polaris writes: every setting on the screen becomes a launch option there,
 * where the game cannot overwrite it. `GameUserSettings.ini` is what the game
 * itself keeps, and it is read only so a row can say what the world is actually
 * running with when nothing here has pinned it - it is never written, because ARK
 * rewrites that file when it shuts down and would throw the edit away.
 *
 * Nothing here takes effect on a running world. ARK reads all of it at start, so
 * every write is followed by "at the next start" on the screen rather than by a
 * pretence that a slider moved something.
 */

import { prisma } from "@polaris/db";
import { withServerContainer } from "@/lib/apps/minecraft/service";
import { ARK_ROOT } from "@/lib/apps/ark/files";
import { readContainerFile, writeContainerFile } from "@/lib/apps/container-files";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import {
    ARK_PENDING_SETTINGS_KEY,
    ARK_SETTINGS_SEEDED_KEY,
    RECOMMENDED_ARK_SETTINGS,
    RECOMMENDED_ARK_VERSION,
    seededVersion,
    GAME_USER_SETTINGS_PATH,
    INSTANCE_CONFIG_PATH,
    findArkSetting,
    normalizeArkValue,
    parseArkOverrides,
    parseIniSection,
    writeArkOverrides
} from "@/lib/apps/ark/settings";

/** The volume the image keeps arkmanager's own files in - one level above the
 *  server files themselves. */
const VOLUME_ROOT = ARK_ROOT.replace(/\/server$/, "");

const CONFIG_FILE = `${VOLUME_ROOT}/${INSTANCE_CONFIG_PATH}`;
const INI_FILE = `${ARK_ROOT}/${GAME_USER_SETTINGS_PATH}`;

/** The section of the game's own file these settings live in. */
const INI_SECTION = "ServerSettings";

export interface ArkRules {
    /** What Polaris has pinned, by setting key. These are what the server is
     *  launched with. */
    readonly overrides: Readonly<Record<string, string>>;
    /** What the game's own file says, for the settings nothing here has pinned.
     *  Only ever shown, never written. */
    readonly live: Readonly<Record<string, string>>;
    /** Why there is nothing to show, when there is nothing. A stopped server is
     *  the usual answer, and it is not an error - the catalogue is Polaris' and
     *  can be drawn either way. */
    readonly reason: string | null;
}

const NOTHING: ArkRules = { overrides: {}, live: {}, reason: null };

/** What one server is set to, and what it is actually running with. */
export async function readArkRules(ownerId: string, installedAppId: string): Promise<ArkRules> {
    return withServerContainer(ownerId, installedAppId, async (server) => {
        const [config, ini] = await Promise.all([
            readContainerFile(server, CONFIG_FILE),
            readContainerFile(server, INI_FILE)
        ]);
        if (config === null && ini === null) {
            return {
                ...NOTHING,
                reason: "This server has not written its settings yet. It does that the first time it starts."
            };
        }
        const live = parseIniSection(ini ?? "", INI_SECTION);
        return {
            overrides: parseArkOverrides(config ?? ""),
            // Only the settings this screen knows about: the file holds a hundred
            // more, and none of them are rows here.
            live: Object.fromEntries(Object.entries(live).filter(([key]) => findArkSetting(key) !== undefined)),
            reason: null
        };
    }).catch(() => ({
        ...NOTHING,
        reason: "The server is stopped, so its settings cannot be read or changed yet."
    }));
}

/**
 * Pin some settings, unpin others, and hand back what the server now holds.
 *
 * A value of null takes the setting off the launch options entirely, which is how
 * a server is put back to whatever the game does by itself - not the same as
 * writing the default in, because the default moves between releases.
 */
export async function setArkRules(
    ownerId: string,
    installedAppId: string,
    changes: Readonly<Record<string, string | null>>
): Promise<ArkRules> {
    const wanted = new Map<string, string | null>();
    for (const [key, raw] of Object.entries(changes)) {
        const setting = findArkSetting(key);
        if (!setting) throw new Error("That is not a setting Polaris can change");
        if (raw === null) {
            wanted.set(key, null);
            continue;
        }
        const value = normalizeArkValue(setting, raw);
        if (value === null) throw new Error(`${setting.label} does not take that value`);
        wanted.set(key, value);
    }
    if (wanted.size === 0) return readArkRules(ownerId, installedAppId);

    return withServerContainer(ownerId, installedAppId, async (server) => {
        const config = (await readContainerFile(server, CONFIG_FILE)) ?? "";
        const overrides: Record<string, string> = { ...parseArkOverrides(config) };
        for (const [key, value] of wanted) {
            if (value === null) delete overrides[key];
            else overrides[key] = value;
        }
        await writeContainerFile(server, CONFIG_FILE, writeArkOverrides(config, overrides));
        const ini = await readContainerFile(server, INI_FILE);
        return {
            overrides,
            live: Object.fromEntries(
                Object.entries(parseIniSection(ini ?? "", INI_SECTION)).filter(
                    ([key]) => findArkSetting(key) !== undefined
                )
            ),
            reason: null
        };
    });
}

/** The settings a server was created with and has not been given yet. */
function readPending(config: Record<string, unknown>): Record<string, string> {
    const raw = config[ARK_PENDING_SETTINGS_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const found: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const setting = findArkSetting(key);
        if (!setting || typeof value !== "string") continue;
        const normalized = normalizeArkValue(setting, value);
        if (normalized !== null) found[key] = normalized;
    }
    return found;
}

/**
 * Give a server the settings it should have and has not been given yet, and report
 * how many that was.
 *
 * Two things arrive here. A server created since Polaris had these defaults
 * carries them on its install row, written at create time because there was no
 * container yet to write them into. A server that already existed carries nothing,
 * and gets the same set once - the recommended handful are the ones that are only
 * ever off because ARK's own defaults were written for public servers a decade
 * ago, and a private server that cannot see itself on its own map is not a
 * decision anybody made.
 *
 * Either way, only the settings nothing has set: this runs behind somebody who may
 * already have opened the Rules screen and chosen differently, and a default that
 * overwrote a decision would be a bug nobody could see. Once a server has been
 * offered them it is never offered them again, so a setting deliberately unpinned
 * stays unpinned.
 *
 * Never throws - the callers are a poll and a cron walk. A server that cannot be
 * reached is tried again next time.
 */
export async function applyPendingArkRules(ownerId: string, installedAppId: string): Promise<number> {
    const install = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    const config = readInstallConfig(install?.config);
    const seeded = seededVersion(config) >= RECOMMENDED_ARK_VERSION;
    const pending = seeded
        ? readPending(config)
        : { ...RECOMMENDED_ARK_SETTINGS, ...readPending(config) };
    if (Object.keys(pending).length === 0) {
        if (!seeded) {
            await patchInstallConfig(installedAppId, {
                [ARK_SETTINGS_SEEDED_KEY]: RECOMMENDED_ARK_VERSION
            });
        }
        return 0;
    }
    try {
        const applied = await withServerContainer(ownerId, installedAppId, async (server) => {
            const config = await readContainerFile(server, CONFIG_FILE);
            // No config file yet means the server has never started, and writing
            // one before arkmanager generates its own would be a file the image
            // then refuses to replace.
            if (config === null) return 0;
            const overrides = parseArkOverrides(config);
            const missing = Object.entries(pending).filter(([key]) => overrides[key] === undefined);
            if (missing.length > 0) {
                await writeContainerFile(
                    server,
                    CONFIG_FILE,
                    writeArkOverrides(config, { ...overrides, ...Object.fromEntries(missing) })
                );
            }
            return missing.length;
        });
        // Cleared whether or not anything was written: a pending setting the
        // operator has already chosen for themselves is not still pending. The
        // flag goes down at the same moment, so this server is never offered the
        // recommended set a second time.
        await patchInstallConfig(installedAppId, {
            [ARK_PENDING_SETTINGS_KEY]: {},
            [ARK_SETTINGS_SEEDED_KEY]: RECOMMENDED_ARK_VERSION
        });
        return applied;
    } catch {
        return 0;
    }
}

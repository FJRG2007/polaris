/**
 * Where display preferences are stored and how a request resolves them.
 *
 * The platform default is one Setting row an operator owns; a user's own choices
 * are a JSON blob on their row. Reads are memoized per request (React cache), so
 * a page that formats in a dozen places still costs one query - the layout
 * resolves them once and hands the result to the client provider.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import {
    AUTOMATIC_TIME_ZONE,
    effectiveTimeZone,
    isThemeId,
    isTimeZone,
    parseDisplayPreferences,
    resolveDisplayPreferences,
    stringifyDisplayPreferences,
    createDisplayFormat,
    type DisplayFormat,
    type DisplayPreferences,
    type ThemeId,
    type UserDisplayPreferences
} from "@polaris/core";
import { getSetting, setSetting } from "./setting-store";
import { resolveSession } from "./session";

/** The Setting key holding the deployment-wide defaults. */
const PLATFORM_KEY = "display.defaults";

/** Whether an account may choose its own theme. Its own key rather than a field
 *  in the defaults blob: it is a policy about who decides, not a format. */
const THEME_POLICY_KEY = "display.userThemes";

/** The operator's defaults for the whole deployment. */
export const getPlatformDisplayPreferences = cache(async (): Promise<UserDisplayPreferences> => {
    return parseDisplayPreferences(await getSetting(PLATFORM_KEY));
});

/** What one account holds: the choices it made, and what its browser reported. */
interface AccountDisplay {
    readonly preferences: UserDisplayPreferences;
    /** The zone this account's browser last said it was in, or null before one
     *  ever has. Not a choice - see `effectiveTimeZone`. */
    readonly deviceTimeZone: string | null;
}

const NOTHING_HELD: AccountDisplay = { preferences: {}, deviceTimeZone: null };

/** Both halves in one read, memoized per request: everything below wants the
 *  reported zone the moment it wants the choices. */
const readAccountDisplay = cache(async (userId: string): Promise<AccountDisplay> => {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { displayPrefs: true, deviceTimeZone: true }
    });
    return {
        preferences: parseDisplayPreferences(row?.displayPrefs),
        deviceTimeZone: row?.deviceTimeZone ?? null
    };
});

/** One user's own choices, which may be partial or empty. */
export async function getUserDisplayPreferences(userId: string): Promise<UserDisplayPreferences> {
    return (await readAccountDisplay(userId)).preferences;
}

/** The zone this account's browser reported, for the screens that have to say
 *  which of the two is deciding. */
export async function getReportedTimeZone(userId: string): Promise<string | null> {
    return (await readAccountDisplay(userId)).deviceTimeZone;
}

/**
 * The effective set for a user: built-in defaults, then platform, then their own.
 *
 * With one substitution the layering cannot express: a zone left on "automatic"
 * is resolved to what this account's browser reported. Automatic means the
 * device's, and every one of these callers is on the server, where there is no
 * device - so without it a date rendered into a page and a status schedule
 * deciding whether somebody is hidden both quietly used the deployment's clock.
 */
export async function resolveDisplayPreferencesFor(userId: string | null): Promise<DisplayPreferences> {
    const [platform, account] = await Promise.all([
        getPlatformDisplayPreferences(),
        userId ? readAccountDisplay(userId) : Promise.resolve(NOTHING_HELD)
    ]);
    const resolved = resolveDisplayPreferences(platform, account.preferences);
    return {
        ...resolved,
        timeZone: effectiveTimeZone(resolved.timeZone, account.deviceTimeZone)
    };
}

/**
 * Write down the zone a browser says it is in.
 *
 * Reported rather than asked for: the alternative is a screen telling somebody
 * to go and pick a timezone before their own schedule works, which is a setup
 * step for something the browser already knows. Refused unless it is a zone this
 * runtime recognises, because it arrives from one.
 *
 * Returns whether anything changed, so the caller can leave the page alone when
 * nothing did - which is every load after the first.
 */
export async function recordDeviceTimeZone(userId: string, zone: string): Promise<boolean> {
    const wanted = zone.trim();
    if (wanted === AUTOMATIC_TIME_ZONE || !isTimeZone(wanted)) return false;
    const changed = await prisma.user.updateMany({
        where: { id: userId, NOT: { deviceTimeZone: wanted } },
        data: { deviceTimeZone: wanted }
    });
    return changed.count > 0;
}

/**
 * Formatters for whoever is asking, for server components. Unauthenticated
 * surfaces (a shared link, a drop point) resolve to the platform defaults, which
 * is the closest thing to a house style a visitor can be shown.
 */
export async function getDisplayFormat(): Promise<DisplayFormat> {
    const session = await resolveSession();
    return createDisplayFormat(await resolveDisplayPreferencesFor(session?.id ?? null));
}

export async function saveUserDisplayPreferences(
    userId: string,
    preferences: UserDisplayPreferences
): Promise<void> {
    await prisma.user.update({
        where: { id: userId },
        data: { displayPrefs: stringifyDisplayPreferences(preferences) }
    });
}

export async function savePlatformDisplayPreferences(preferences: DisplayPreferences): Promise<void> {
    await setSetting(PLATFORM_KEY, stringifyDisplayPreferences(preferences));
}

/**
 * Whether accounts may pick their own theme.
 *
 * On unless an operator has said otherwise, because which theme somebody reads
 * a screen in for eight hours is theirs to decide - an instance that wants one
 * look everywhere turns it off, and every account then follows the default.
 */
export const usersMayChooseTheme = cache(async (): Promise<boolean> => {
    return (await getSetting(THEME_POLICY_KEY)) !== "off";
});

export async function setUsersMayChooseTheme(allowed: boolean): Promise<void> {
    await setSetting(THEME_POLICY_KEY, allowed ? "on" : "off");
}

/**
 * The theme a request is drawn in.
 *
 * The platform's choice, then the account's own on top of it - unless the
 * operator has taken that away, in which case the account's stored choice is
 * ignored rather than deleted: turning the setting back on gives everybody their
 * theme back instead of resetting the instance.
 *
 * Never throws. It is read by the root layout, which renders before anything
 * else and also renders when there is no database to ask - a build prerendering
 * a page, an instance that has not been migrated yet - and a theme is not worth
 * failing a page over.
 */
export async function resolveTheme(userId: string | null): Promise<ThemeId> {
    try {
        const [platform, allowed] = await Promise.all([
            getPlatformDisplayPreferences(),
            usersMayChooseTheme()
        ]);
        const mine = allowed && userId ? await getUserDisplayPreferences(userId) : {};
        const chosen = mine.theme ?? platform.theme;
        return isThemeId(chosen) ? chosen : "dark";
    } catch {
        return "dark";
    }
}

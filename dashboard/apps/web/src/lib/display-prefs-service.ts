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
    parseDisplayPreferences,
    resolveDisplayPreferences,
    stringifyDisplayPreferences,
    createDisplayFormat,
    type DisplayFormat,
    type DisplayPreferences,
    type UserDisplayPreferences
} from "@polaris/core";
import { getSetting, setSetting } from "./setting-store";
import { resolveSession } from "./session";

/** The Setting key holding the deployment-wide defaults. */
const PLATFORM_KEY = "display.defaults";

/** The operator's defaults for the whole deployment. */
export const getPlatformDisplayPreferences = cache(async (): Promise<UserDisplayPreferences> => {
    return parseDisplayPreferences(await getSetting(PLATFORM_KEY));
});

/** One user's own choices, which may be partial or empty. */
export const getUserDisplayPreferences = cache(async (userId: string): Promise<UserDisplayPreferences> => {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { displayPrefs: true } });
    return parseDisplayPreferences(row?.displayPrefs);
});

/** The effective set for a user: built-in defaults, then platform, then their own. */
export async function resolveDisplayPreferencesFor(userId: string | null): Promise<DisplayPreferences> {
    const [platform, user] = await Promise.all([
        getPlatformDisplayPreferences(),
        userId ? getUserDisplayPreferences(userId) : Promise.resolve({})
    ]);
    return resolveDisplayPreferences(platform, user);
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

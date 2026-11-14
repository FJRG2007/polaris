/**
 * Which language an account reads Polaris in: stored, read and changed here.
 *
 * `getUserLocale(userId)` is the one question every part of the server asks -
 * the page being drawn, a notification for somebody else, a line sent into a
 * game for a linked player. It is asked often and changes rarely, so answers are
 * kept in memory for a few minutes and dropped the moment the account changes
 * its language through `setUserLocale`.
 *
 * The cache is on globalThis, not in this module: the action that writes a
 * change and the code that reads it can be different copies of this file (Next
 * bundles server components, route handlers and start-up code separately), and
 * a change made through one copy has to be seen by all of them.
 *
 * When nothing is known about somebody - no language on the account, and a
 * browser that names none Polaris has - the deployment's default language
 * answers (`deploymentLocale`), and the built-in one when the operator never set
 * one.
 */

import { prisma } from "@polaris/db";
import { getSetting } from "@/lib/setting-store";
import { publishLocaleChange } from "./locale-live";
import { DEFAULT_LOCALE, isLocale, parseDisplayPreferences, type Locale } from "@polaris/core";

/** The Setting key holding the deployment's display defaults, the default
 *  language among them (see display-prefs-service). */
export const PLATFORM_DISPLAY_KEY = "display.defaults";

/** How long the deployment's default language is kept before it is read again.
 *  A save through `forgetDeploymentLocale` lands at once regardless. */
const DEPLOYMENT_TTL_MS = 60_000;

const DEPLOYMENT = Symbol.for("polaris.locale.deployment");

interface DeploymentHeld {
    readonly locale: Locale;
    readonly at: number;
}

function deploymentHolder(): { [DEPLOYMENT]?: DeploymentHeld } {
    return globalThis as { [DEPLOYMENT]?: DeploymentHeld };
}

/**
 * The language an operator chose for somebody Polaris knows nothing about, or
 * the built-in default when none was chosen.
 *
 * A last resort only: an account's own language and what a browser asks for
 * both come first. Never throws - a database that cannot be read answers with
 * the built-in default rather than failing a page or a notice.
 */
export async function deploymentLocale(): Promise<Locale> {
    const held = deploymentHolder()[DEPLOYMENT];
    if (held && Date.now() - held.at < DEPLOYMENT_TTL_MS) return held.locale;
    try {
        const chosen = parseDisplayPreferences(await getSetting(PLATFORM_DISPLAY_KEY)).language;
        const locale = isLocale(chosen) ? chosen : DEFAULT_LOCALE;
        deploymentHolder()[DEPLOYMENT] = { locale, at: Date.now() };
        return locale;
    } catch {
        return DEFAULT_LOCALE;
    }
}

/** The deployment's defaults changed: the next question reads them again. */
export function forgetDeploymentLocale(): void {
    delete deploymentHolder()[DEPLOYMENT];
}

/** Long enough to spare the database a read per page, short enough that a
 *  change made outside `setUserLocale` (a database edit, a restore) lands. */
const TTL_MS = 5 * 60_000;

/** A bound on accounts remembered, so a sweep over every account (a job that
 *  notifies everybody) cannot grow this without end. */
const MAX_ENTRIES = 5000;

interface Held {
    readonly locale: Locale | null;
    readonly at: number;
}

const CACHE = Symbol.for("polaris.locale.cache");

function cache(): Map<string, Held> {
    const holder = globalThis as { [CACHE]?: Map<string, Held> };
    return (holder[CACHE] ??= new Map());
}

function remember(userId: string, locale: Locale | null): void {
    const held = cache();
    if (held.size >= MAX_ENTRIES) held.clear();
    held.set(userId, { locale, at: Date.now() });
}

/**
 * The language an account has, or null when none has been worked out yet - an
 * account created before languages existed that has not been back since.
 * A stored value that is not a locale Polaris has (one removed in a later
 * release) reads as null too, so it is detected again rather than trusted.
 */
export async function storedLocale(userId: string): Promise<Locale | null> {
    const held = cache().get(userId);
    if (held && Date.now() - held.at < TTL_MS) return held.locale;
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { locale: true } });
    const locale = isLocale(row?.locale) ? row.locale : null;
    remember(userId, locale);
    return locale;
}

/**
 * The language to address an account in. Never null: an account with nothing
 * stored reads the deployment's default until its next request detects one.
 */
export async function getUserLocale(userId: string): Promise<Locale> {
    return (await storedLocale(userId)) ?? (await deploymentLocale());
}

/**
 * The account chose a language. Stored, remembered, and announced to every tab
 * the account has open, which redraws in it.
 */
export async function setUserLocale(userId: string, locale: Locale): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { locale } });
    remember(userId, locale);
    publishLocaleChange({ userId, locale });
}

/**
 * A language worked out for an account that had none.
 *
 * Written only where the column is still empty, so a detection that races a
 * choice - two tabs, one of them on the settings page - never overwrites what
 * somebody picked. Returns what the account ends up with.
 */
export async function recordDetectedLocale(userId: string, locale: Locale): Promise<Locale> {
    const written = await prisma.user.updateMany({ where: { id: userId, locale: null }, data: { locale } });
    if (written.count > 0) {
        remember(userId, locale);
        return locale;
    }
    cache().delete(userId);
    return getUserLocale(userId);
}

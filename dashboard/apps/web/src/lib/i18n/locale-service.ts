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
 */

import { prisma } from "@polaris/db";
import { publishLocaleChange } from "./locale-live";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@polaris/core";

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
 * stored reads the default until its next request detects one.
 */
export async function getUserLocale(userId: string): Promise<Locale> {
    return (await storedLocale(userId)) ?? DEFAULT_LOCALE;
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

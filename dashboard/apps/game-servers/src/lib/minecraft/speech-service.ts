/**
 * Who on a server reads which language (`speech.ts` does the splitting).
 *
 * A player linked to a Polaris account reads that account's language; anybody
 * else - and a linked player whose account has never had a language worked
 * out - reads the server's own. Each online player carries the tag of theirs
 * (`pl_en`, `pl_es`), put on as they are first seen and changed when their
 * account's language does, so a broadcast can be narrowed to its readers.
 *
 * The server's own language is the one the operator chose for events; one that
 * was never chosen is the server owner's.
 */

import * as speech from "./speech";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { ServerContainer } from "./service";
import { ROSTER, rosterNames } from "./events/replies";

/** How long a look at who is on, and what each reads, holds. */
const HEAR_EVERY_MS = 10_000;

interface Heard {
    readonly audience: speech.Audience;
    readonly at: number;
    /** The tag each player was last given, so it is only sent when it changes. */
    readonly tagged: ReadonlyMap<string, speech.Language>;
}

const heard = new Map<string, Heard>();

/** The last look at a server: everybody in its own language before any. */
export function audienceFor(installedAppId: string, home: speech.Language): speech.Audience {
    const held = heard.get(installedAppId);
    return held && held.audience.home === home
        ? held.audience
        : speech.audienceOf(home, held?.audience.of);
}

/** Forget a server: its players are tagged again from scratch on the next look. */
export function forget(installedAppId: string): void {
    heard.delete(installedAppId);
}

/**
 * The language an account has, or null when it has none yet. Not the
 * dashboard's default: an account made before Polaris spoke Spanish, whose
 * owner has not signed in since, would read English on a Spanish server.
 */
async function localeOf(userId: string): Promise<string | null> {
    try {
        return await host.i18nLocaleService.storedLocale(userId);
    } catch {
        return null;
    }
}

/** What a linked account reads in the game: its own language, or the server's. */
export async function accountLanguage(
    userId: string,
    home: speech.Language
): Promise<speech.Language> {
    const locale = await localeOf(userId);
    return locale ? speech.gameLanguage(locale) : home;
}

/**
 * Who is on and what each reads, looked at again when the last look is older
 * than a few seconds (or `force`); each player whose language is new or changed
 * gets its tag. A server that cannot be asked keeps the last look.
 */
export async function hear(
    installedAppId: string,
    server: ServerContainer,
    home: speech.Language,
    force = false
): Promise<speech.Audience> {
    const held = heard.get(installedAppId);
    if (!force && held && held.audience.home === home && Date.now() - held.at < HEAR_EVERY_MS)
        return held.audience;
    let names: string[];
    try {
        names = rosterNames(await server.say([ROSTER]));
    } catch {
        return audienceFor(installedAppId, home);
    }
    const links = new Map(
        (
            await prisma.gamePlayerLink
                .findMany({ where: { installedAppId }, select: { player: true, userId: true } })
                .catch(() => [])
        ).map((row) => [row.player.toLowerCase(), row.userId])
    );
    const of = new Map<string, speech.Language>();
    const locales = new Map<string, speech.Language>();
    for (const name of names) {
        const userId = links.get(name.toLowerCase());
        let language = home;
        if (userId) {
            language = locales.get(userId) ?? (await accountLanguage(userId, home));
            locales.set(userId, language);
        }
        of.set(name.toLowerCase(), language);
    }
    const tagged = new Map(held?.tagged ?? []);
    const lines: string[] = [];
    for (const name of names) {
        const language = of.get(name.toLowerCase())!;
        if (tagged.get(name.toLowerCase()) === language) continue;
        lines.push(...speech.tagLines(name, language));
        tagged.set(name.toLowerCase(), language);
    }
    if (lines.length > 0) await server.sayAll(lines).catch(() => undefined);
    const audience = speech.audienceOf(home, of);
    heard.set(installedAppId, { audience, at: Date.now(), tagged });
    return audience;
}

/** A server whose lines are each split for its readers before they are sent. */
export function speaking(
    server: ServerContainer,
    audience: () => speech.Audience
): ServerContainer {
    return {
        ...server,
        say: async (argv) => {
            const lines = speech.localize(argv.join(" "), audience());
            if (lines.length === 1 && lines[0] === argv.join(" ")) return server.say(argv);
            const said: string[] = [];
            for (const line of lines) said.push(await server.say([line]));
            return said.join("");
        },
        sayAll: async (lines) => server.sayAll(speech.localizeAll(lines, audience()))
    };
}

/**
 * The server's own language: the one chosen for its events, or - never chosen -
 * the language of the account that owns the server.
 */
export async function homeLanguage(
    ownerId: string,
    chosen: speech.Language | null
): Promise<speech.Language> {
    if (chosen) return chosen;
    return speech.gameLanguage(await localeOf(ownerId));
}

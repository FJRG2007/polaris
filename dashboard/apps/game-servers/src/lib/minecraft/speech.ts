/**
 * Every player reads events and challenges in their own language.
 *
 * What a player reads is written once, for everybody, in "every language"
 * (`EVERY`): each message comes back as a token that carries all of its
 * renderings. The line is only split at the last moment, on its way to the
 * server (`localize`): one copy per language somebody online reads, each sent to
 * the players who read it - a broadcast narrowed by a tag every player carries
 * (`pl_en`, `pl_es`), a line to one player in that player's language, and
 * anything nobody in particular reads (a boss bar's name, a side panel's title)
 * in the server's own language.
 *
 * Pure: who reads what is worked out by `speech-service`.
 */

import { asciiJson } from "./events/commands";
import { javaComponent } from "./announcement";

export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Written for everybody, in every language. */
export const EVERY = "*";
export type Speech = Language | typeof EVERY;

/** A token inside a line: every rendering of one message. The characters are
 *  private-use ones and the body base64url, so no colour code, brace or quote a
 *  line is read for can appear in it. */
const OPEN = "\uE000";
const CLOSE = "\uE001";
const TOKEN = /\uE000([A-Za-z0-9_-]+)\uE001/g;
/** The same token once a line has become the game's JSON, which writes every
 *  character past ASCII as an escape. */
const ESCAPED_TOKEN = /\\ue000([A-Za-z0-9_-]+)\\ue001/g;
/** A whole formatted line in every language, as `text` hands it back. */
const PLACEHOLDER = /\{"polaris":"([A-Za-z0-9_-]+)","text":""\}/g;

type Renderings = Readonly<Record<Language, string>>;

function encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(body: string): Renderings | null {
    try {
        const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
        if (!value || typeof value !== "object") return null;
        const record = value as Record<string, unknown>;
        return LANGUAGES.every((language) => typeof record[language] === "string")
            ? (record as Renderings)
            : null;
    } catch {
        return null;
    }
}

/** One message in every language: a token when they differ. */
export function both(renderings: Renderings): string {
    const first = renderings[LANGUAGES[0]];
    if (LANGUAGES.every((language) => renderings[language] === first)) return first;
    return `${OPEN}${encode(renderings)}${CLOSE}`;
}

/** A message from its renderings, in one language or in every one. */
export function pickIn(renderings: Renderings, speech: Speech): string {
    return speech === EVERY ? both(renderings) : renderings[speech];
}

/** Whether a text still holds a message in every language. */
export function speaks(text: string): boolean {
    return text.includes(OPEN);
}

/** A text as one language reads it: every token in it resolved, and any token
 *  inside those. */
export function said(text: string, language: Language): string {
    let out = text;
    for (let depth = 0; depth < 8 && out.includes(OPEN); depth += 1) {
        out = out.replace(TOKEN, (_whole, body: string) => decode(body)?.[language] ?? "");
    }
    return out;
}

type Widened<A extends readonly unknown[]> = {
    [K in keyof A]: A[K] extends Language ? Speech : A[K];
};
type Spoken<M> = {
    [K in keyof M]: M[K] extends (...args: infer A) => infer R ? (...args: Widened<A>) => R : M[K];
};

/** The renderings of one answer merged: words become a token, and a list or a
 *  record of words is merged word by word; anything else is the first's. */
function merged(renderings: Readonly<Record<Language, unknown>>): unknown {
    const first = renderings[LANGUAGES[0]];
    if (typeof first === "string") {
        return both(
            Object.fromEntries(LANGUAGES.map((one) => [one, String(renderings[one])])) as Renderings
        );
    }
    if (Array.isArray(first)) {
        return first.map((_, index) =>
            merged(
                Object.fromEntries(
                    LANGUAGES.map((one) => [
                        one,
                        (renderings[one] as unknown[] | undefined)?.[index]
                    ])
                ) as Record<Language, unknown>
            )
        );
    }
    if (first && typeof first === "object") {
        return Object.fromEntries(
            Object.keys(first).map((key) => [
                key,
                merged(
                    Object.fromEntries(
                        LANGUAGES.map((one) => [
                            one,
                            (renderings[one] as Record<string, unknown> | undefined)?.[key]
                        ])
                    ) as Record<Language, unknown>
                )
            ])
        );
    }
    return first;
}

/**
 * A module of messages, able to write each of them in every language: a call
 * given `EVERY` for its language is made once per language and its answers
 * merged into tokens (`merged`). Anything else passes through untouched.
 */
export function spoken<M extends object>(module: M): Spoken<M> {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(module)) {
        if (typeof value !== "function") {
            out[name] = value;
            continue;
        }
        const fn = value as (...args: unknown[]) => unknown;
        out[name] = (...args: unknown[]) => {
            if (!args.includes(EVERY)) return fn(...args);
            const renderings: Record<string, unknown> = {};
            for (const language of LANGUAGES) {
                renderings[language] = fn(...args.map((arg) => (arg === EVERY ? language : arg)));
            }
            return merged(renderings as Record<Language, unknown>);
        };
    }
    return out as Spoken<M>;
}

/**
 * A line with `&` colour codes as the game's JSON. A line holding messages in
 * every language becomes a placeholder carrying each language's own JSON, so
 * each is formatted exactly as it would be alone; `localize` puts the right one
 * back before it is sent.
 */
export function formatted(line: string, prefix = false): string {
    if (!speaks(line)) return asciiJson(javaComponent(line, prefix));
    const each: Record<string, string> = {};
    for (const language of LANGUAGES)
        each[language] = asciiJson(javaComponent(said(line, language), prefix));
    return `{"polaris":"${encode(each)}","text":""}`;
}

// ------------------------------------------------------------------ who reads what

/** The tag every online player carries for the language they read. */
export function languageTag(language: Language): string {
    return `pl_${language}`;
}

/** Who is online and what each reads, by lowercased name, and what everybody
 *  else - a player not looked at yet - reads. */
export interface Audience {
    readonly home: Language;
    readonly of: ReadonlyMap<string, Language>;
}

export function audienceOf(
    home: Language,
    of: ReadonlyMap<string, Language> = new Map()
): Audience {
    return { home, of };
}

/** The languages somebody online reads: the server's own first. */
function spokenBy(audience: Audience): Language[] {
    const present = new Set(audience.of.values());
    if (present.size === 0) return [audience.home];
    return [audience.home, ...LANGUAGES.filter((one) => one !== audience.home)].filter((one) =>
        present.has(one)
    );
}

/** A line as one language reads it: each placeholder its language's JSON, each
 *  token left inside a JSON string its language's words. */
function render(line: string, language: Language): string {
    return line
        .replace(PLACEHOLDER, (_whole, body: string) => decode(body)?.[language] ?? '""')
        .replace(ESCAPED_TOKEN, (_whole, body: string) =>
            asciiJson(JSON.stringify(said(decode(body)?.[language] ?? "", language))).slice(1, -1)
        )
        .replace(TOKEN, (_whole, body: string) => said(decode(body)?.[language] ?? "", language));
}

/** `@a` or `@a[...]` narrowed to also match `extra`. */
function narrowed(selector: string, extra: string): string {
    return selector === "@a" ? `@a[${extra}]` : `${selector.slice(0, -1)},${extra}]`;
}

/** The first `@a` in a line, with its arguments - brackets inside them (an
 *  `nbt` test's lists) counted, so it ends where the selector does. Only looked
 *  for before the first quote: an `@a` inside the words is not a selector. */
function everybodyIn(line: string): { index: number; selector: string } | null {
    const quote = line.indexOf('"');
    const index = (quote < 0 ? line : line.slice(0, quote)).search(/@a(?![A-Za-z0-9_])/);
    if (index < 0) return null;
    if (line[index + 2] !== "[") return { index, selector: "@a" };
    let depth = 0;
    for (let at = index + 2; at < line.length; at += 1) {
        if (line[at] === "[") depth += 1;
        else if (line[at] === "]" && --depth === 0)
            return { index, selector: line.slice(index, at + 1) };
    }
    return null;
}

const ONE_PLAYER =
    /^(?:(?:minecraft:)?execute (?:as|at) (\S+) .*? run )?(?:minecraft:)?(?:tellraw|title) (\S+) /;

/**
 * A line on its way to the server: as it is when nothing in it is written in
 * every language; otherwise one copy per language somebody reads - a broadcast
 * to each language's readers, a line to one player in theirs, anything else in
 * the server's own.
 */
export function localize(line: string, audience: Audience): string[] {
    if (!line.includes("\uE000") && !line.includes('{"polaris":"') && !/\\ue000/.test(line))
        return [line];
    if (everybodyIn(line)) {
        const languages = spokenBy(audience);
        if (languages.length === 1) return [render(line, languages[0]!)];
        const others = (language: Language) => languages.filter((one) => one !== language);
        return languages.map((language) => {
            const extra =
                language === audience.home
                    ? others(language)
                          .map((one) => `tag=!${languageTag(one)}`)
                          .join(",")
                    : `tag=${languageTag(language)}`;
            const copy = render(line, language);
            const at = everybodyIn(copy)!;
            return `${copy.slice(0, at.index)}${narrowed(at.selector, extra)}${copy.slice(at.index + at.selector.length)}`;
        });
    }
    const one = ONE_PLAYER.exec(line);
    const name = one ? (one[1] && !one[1].startsWith("@") ? one[1] : one[2]) : null;
    const language =
        name && !name.startsWith("@")
            ? (audience.of.get(name.toLowerCase()) ?? audience.home)
            : audience.home;
    return [render(line, language)];
}

/** Every line on its way to the server, split as `localize` splits each. */
export function localizeAll(lines: readonly string[], audience: Audience): string[] {
    return lines.flatMap((line) => localize(line, audience));
}

/** What a Polaris account's language is to the game: Spanish for any Spanish,
 *  English for everything else. */
export function gameLanguage(locale: string | null | undefined): Language {
    return typeof locale === "string" && /^es\b/i.test(locale) ? "es" : "en";
}

/** The tag commands that bring one player to a language: the other one taken
 *  off first, so nobody is ever in two. */
export function tagLines(name: string, language: Language): string[] {
    return [
        ...LANGUAGES.filter((one) => one !== language).map(
            (one) => `tag ${name} remove ${languageTag(one)}`
        ),
        `tag ${name} add ${languageTag(language)}`
    ];
}

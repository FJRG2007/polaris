/**
 * Turning a catalog entry into the sentence somebody reads.
 *
 * Messages are ICU MessageFormat - `{count, plural, one {# file} other {# files}}`,
 * `{kind, select, ...}`, `<link>tags</link>` - parsed and formatted by
 * `intl-messageformat`, the reference implementation, rather than by a pattern
 * of our own: plural rules differ per language, and getting them from the same
 * CLDR data the browser uses is the point.
 *
 * Nothing here knows where catalogs live or who is reading. The dashboard, an
 * installed app and a job with no request at all build a translator from a
 * locale and a catalog they already hold, which is what keeps this usable from a
 * Minecraft message, an email or a notification as well as from a screen.
 */

import { isCompleteLocale, SOURCE_LOCALE, type Locale } from "./locales.js";
import { IntlMessageFormat, type Formatters, type PrimitiveType } from "intl-messageformat";
import { clientMessageValues, type Client } from "../client-surface.js";

/** What a message reads `{clientKind}` and `{surface}` as when nobody said: a browser,
 *  which is what every translator outside a page (a job, a test) is closest to. */
const CLIENT_FALLBACK = clientMessageValues("browser");

/** A catalog: nested groups of messages, keyed by name. */
export interface Catalog {
    readonly [key: string]: string | Catalog;
}

/** Every dotted path to a message in a catalog: `"title"`, `"language.hint"`. */
export type MessageKey<T> = T extends string
    ? never
    : {
          [K in keyof T & string]: T[K] extends string ? K : `${K}.${MessageKey<T[K]>}`;
      }[keyof T & string];

/** The shape another locale's catalog must have: the same keys, any wording. */
export type CatalogShape<T> = {
    readonly [K in keyof T]: T[K] extends string ? string : CatalogShape<T[K]>;
};

/** The shape a partly translated locale's catalog may have: any of the source's
 *  keys, none of its own. */
export type PartialCatalogShape<T> = {
    readonly [K in keyof T]?: T[K] extends string ? string : PartialCatalogShape<T[K]>;
};

/** A value a message can be filled with. Dates are better formatted first, with
 *  the reader's display preferences, and passed in as text - see docs/i18n.md. */
export type MessageValue = PrimitiveType;

export type MessageParams = Readonly<Record<string, MessageValue>>;

/** A tag in a message (`<link>here</link>`), drawn by the caller: it gets the
 *  already translated text inside the tag and returns what to put there. */
export type RichTag<R> = (chunks: (string | R)[]) => R;

export type RichParams<R> = Readonly<Record<string, MessageValue | R | RichTag<R>>>;

/** What a translator reports when a message cannot be produced. */
export interface MessageProblem {
    readonly kind: "missing" | "format";
    readonly locale: Locale;
    /** The full key, namespace included. */
    readonly key: string;
    readonly detail?: string;
}

export interface Translator<K extends string = string> {
    /** The message at `key`, filled in. Returns the key itself when there is no
     *  such message, which the catalog tests make a build failure rather than
     *  something a reader sees. A partial locale's catalogs reach a translator
     *  already filled in from the source (`mergeCatalog`), so a message it has
     *  not translated yet is read in the source language, never as its key. */
    (key: K, params?: MessageParams): string;
    /** The same, for a message with tags in it: the parts in order, ready to be
     *  rendered side by side. Never concatenate two translations instead. */
    rich<R>(key: K, params: RichParams<R>): (string | R)[];
    /** Whether the catalog has a message at `key`. For a key built at runtime from
     *  data - a label - where absence is an answer rather than a mistake. */
    has(key: string): key is K;
    readonly locale: Locale;
}

/** Formatters are built once per locale and message: parsing is the expensive
 *  half, and the same few hundred messages are formatted all day. */
const MAX_CACHED = 4000;
const formats = new Map<string, IntlMessageFormat>();

/** Numbers and dates in the reader's locale, plurals chosen by the source's
 *  rules: for a message whose branches were written for the source language. */
const SOURCE_PLURALS: Formatters = {
    getNumberFormat: (locales, options) =>
        new Intl.NumberFormat(locales, options as Intl.NumberFormatOptions),
    getDateTimeFormat: (...args) => new Intl.DateTimeFormat(...args),
    getPluralRules: (_locales, options) => new Intl.PluralRules(SOURCE_LOCALE, options)
};

interface PluralNode {
    readonly type: number;
    readonly pluralType?: "cardinal" | "ordinal";
    readonly options?: Readonly<Record<string, { readonly value: readonly PluralNode[] }>>;
    readonly children?: readonly PluralNode[];
}

/** Whether every plural in a message has a branch for every category the
 *  locale's own rules can pick. A message that does not was written for another
 *  language - the source's message a partial locale fell back to - and its
 *  branches only make sense under that language's rules. */
function coversPlurals(locale: Locale, nodes: readonly PluralNode[]): boolean {
    for (const node of nodes) {
        if (node.type === 6 && node.options) {
            const wanted = new Intl.PluralRules(locale, {
                type: node.pluralType ?? "cardinal"
            }).resolvedOptions().pluralCategories;
            if (wanted.some((category) => !Object.hasOwn(node.options!, category))) return false;
        }
        for (const option of Object.values(node.options ?? {}))
            if (!coversPlurals(locale, option.value)) return false;
        if (node.children && !coversPlurals(locale, node.children)) return false;
    }
    return true;
}

function formatterFor(locale: Locale, message: string): IntlMessageFormat {
    const cacheKey = `${locale}\u0000${message}`;
    const found = formats.get(cacheKey);
    if (found) return found;
    let created = new IntlMessageFormat(message, locale);
    // A partial locale reads some messages in the source language. Their numbers
    // and dates still follow the reader's locale, like the rest of the screen,
    // but "one" and "other" were written for the source's plural rules: under a
    // language that picks "one" for 21, or has no "one" at all, they would choose
    // the wrong form. See docs/i18n.md, "Partial locales".
    if (
        !isCompleteLocale(locale) &&
        !coversPlurals(locale, created.getAst() as unknown as PluralNode[])
    )
        created = new IntlMessageFormat(message, locale, undefined, { formatters: SOURCE_PLURALS });
    if (formats.size >= MAX_CACHED) formats.clear();
    formats.set(cacheKey, created);
    return created;
}

/** Reported once per locale and key, so a missing message in a list of two
 *  hundred rows is one line in a log and not two hundred. */
const reported = new Set<string>();

function reportOnce(problem: MessageProblem): void {
    const id = `${problem.kind}:${problem.locale}:${problem.key}`;
    if (reported.has(id)) return;
    reported.add(id);
    console.error(
        `[i18n] ${problem.kind === "missing" ? "No message" : "Message could not be formatted"} for "${problem.key}" in ${problem.locale}${problem.detail ? `: ${problem.detail}` : ""}`
    );
}

/**
 * The message at a dotted path, or undefined when the path does not end on one.
 *
 * A catalog may name an entry after something that has dots of its own - the
 * subject `task.space`, the command `container.restart` - so a segment the
 * catalog does not hold is tried joined to the ones after it before the path is
 * given up on. `share.subjects.task.space` reaches `subjects["task.space"]`.
 */
export function lookupMessage(catalog: Catalog | undefined, key: string): string | undefined {
    return lookupParts(catalog, key.split("."), 0);
}

function lookupParts(node: string | Catalog | undefined, parts: readonly string[], from: number): string | undefined {
    if (from === parts.length) return typeof node === "string" ? node : undefined;
    if (node === undefined || typeof node === "string") return undefined;
    let name = parts[from]!;
    for (let next = from + 1; next <= parts.length; next += 1) {
        if (Object.hasOwn(node, name)) {
            const found = lookupParts(node[name], parts, next);
            if (found !== undefined) return found;
        }
        if (next < parts.length) name = `${name}.${parts[next]}`;
    }
    return undefined;
}

/**
 * One message, formatted for a locale. On a formatting failure - a parameter the
 * caller forgot - the raw message is returned rather than an exception thrown
 * into a render, and the failure is reported.
 */
export function formatMessage(
    locale: Locale,
    message: string,
    params?: MessageParams,
    onProblem: (problem: MessageProblem) => void = reportOnce,
    key = message
): string {
    try {
        const result = formatterFor(locale, message).format({
            ...CLIENT_FALLBACK,
            ...params
        } as Record<string, PrimitiveType>);
        return Array.isArray(result) ? result.join("") : String(result);
    } catch (caught) {
        onProblem({
            kind: "format",
            locale,
            key,
            detail: caught instanceof Error ? caught.message : undefined
        });
        return message;
    }
}

function formatRich<R>(
    locale: Locale,
    message: string,
    params: RichParams<R>,
    onProblem: (problem: MessageProblem) => void,
    key: string
): (string | R)[] {
    try {
        const result = formatterFor(locale, message).format<R>({
            ...CLIENT_FALLBACK,
            ...params
        } as Record<string, PrimitiveType | R | RichTag<R>>);
        return Array.isArray(result) ? result : [result];
    } catch (caught) {
        onProblem({
            kind: "format",
            locale,
            key,
            detail: caught instanceof Error ? caught.message : undefined
        });
        return [message];
    }
}

export interface TranslatorOptions {
    /** Prefixed to every key in what is reported, so a problem names the file it
     *  is in. */
    readonly namespace?: string;
    /** Where problems go. Logged once per key by default. */
    readonly onProblem?: (problem: MessageProblem) => void;
    /** The Polaris this text is read in, offered to every message as `{clientKind}`
     *  and `{surface}` so a catalog entry can word itself for a browser or for the
     *  app (see client-surface.ts). A browser when not given. */
    readonly client?: Client;
}

/**
 * A translator over one catalog - usually one namespace of one locale.
 *
 * Pure apart from the report: the same locale, catalog and key give the same
 * text on the server, in the browser and in a job.
 */
export function createTranslator<T extends Catalog>(
    locale: Locale,
    catalog: T | undefined,
    options: TranslatorOptions = {}
): Translator<MessageKey<T>> {
    const onProblem = options.onProblem ?? reportOnce;
    const qualified = (key: string) => (options.namespace ? `${options.namespace}.${key}` : key);

    function resolve(key: string): string | undefined {
        const message = lookupMessage(catalog, key);
        if (message === undefined) onProblem({ kind: "missing", locale, key: qualified(key) });
        return message;
    }

    // The caller's own values win: a screen that passes `surface` for a reason
    // of its own is not overridden by where it happens to be drawn.
    const surface = options.client ? clientMessageValues(options.client) : undefined;

    const translate = ((key: string, params?: MessageParams) => {
        const message = resolve(key);
        if (message === undefined) return qualified(key);
        return formatMessage(
            locale,
            message,
            surface ? { ...surface, ...params } : params,
            onProblem,
            qualified(key)
        );
    }) as unknown as Translator<MessageKey<T>>;

    translate.rich = <R>(key: string, params: RichParams<R>) => {
        const message = resolve(key);
        if (message === undefined) return [qualified(key)];
        return formatRich(
            locale,
            message,
            surface ? { ...surface, ...params } : params,
            onProblem,
            qualified(key)
        );
    };
    translate.has = (key: string): key is MessageKey<T> =>
        lookupMessage(catalog, key) !== undefined;
    Object.defineProperty(translate, "locale", { value: locale, enumerable: true });
    return translate;
}

/** Every message in a catalog, by its dotted key. */
export function flattenCatalog(catalog: Catalog, prefix = ""): Map<string, string> {
    const found = new Map<string, string>();
    for (const [name, value] of Object.entries(catalog)) {
        const key = prefix ? `${prefix}.${name}` : name;
        if (typeof value === "string") found.set(key, value);
        else for (const [inner, text] of flattenCatalog(value, key)) found.set(inner, text);
    }
    return found;
}

/**
 * A partial locale's catalog filled in from the source's: every key the source
 * has, in the translation where there is one and in the source's words where
 * there is not. A key only the translation has is dropped - it names nothing a
 * screen can ask for, and the catalog tests report it.
 */
export function mergeCatalog(source: Catalog, translated: Catalog | undefined): Catalog {
    if (!translated) return source;
    const merged: Record<string, string | Catalog> = {};
    for (const [name, value] of Object.entries(source)) {
        const own = Object.hasOwn(translated, name) ? translated[name] : undefined;
        merged[name] =
            typeof value === "string"
                ? typeof own === "string"
                    ? own
                    : value
                : mergeCatalog(value, typeof own === "object" ? own : undefined);
    }
    return merged;
}

/** How much of a source catalog a translation covers, counted in messages. */
export function catalogCoverage(
    source: Catalog,
    translated: Catalog | undefined
): { readonly translated: number; readonly total: number } {
    const own = translated ? flattenCatalog(translated) : new Map<string, string>();
    let done = 0;
    let total = 0;
    for (const key of flattenCatalog(source).keys()) {
        total += 1;
        if (own.has(key)) done += 1;
    }
    return { translated: done, total };
}

interface AstNode {
    readonly type: number;
    readonly value?: unknown;
    readonly options?: Readonly<Record<string, { readonly value: readonly AstNode[] }>>;
    readonly children?: readonly AstNode[];
}

/** The ICU element types that name an argument, as intl-messageformat numbers
 *  them: argument, number, date, time, select, plural. Tags (8) name a tag. */
const ARGUMENT_TYPES = new Set([1, 2, 3, 4, 5, 6]);
const TAG_TYPE = 8;

function collect(nodes: readonly AstNode[], args: Set<string>, tags: Set<string>): void {
    for (const node of nodes) {
        if (ARGUMENT_TYPES.has(node.type) && typeof node.value === "string") args.add(node.value);
        if (node.type === TAG_TYPE && typeof node.value === "string") tags.add(node.value);
        for (const option of Object.values(node.options ?? {})) collect(option.value, args, tags);
        if (node.children) collect(node.children, args, tags);
    }
}

/**
 * Whether a message is valid ICU for a locale, and the arguments and tags it
 * uses. The catalog tests compare these across locales, so a translation that
 * drops `{count}` or renames `<link>` fails the build instead of a render.
 */
export function inspectMessage(
    locale: Locale,
    message: string
): { ok: true; args: string[]; tags: string[] } | { ok: false; error: string } {
    try {
        const ast = new IntlMessageFormat(message, locale).getAst() as unknown as AstNode[];
        const args = new Set<string>();
        const tags = new Set<string>();
        collect(ast, args, tags);
        return { ok: true, args: [...args].sort(), tags: [...tags].sort() };
    } catch (caught) {
        return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
    }
}

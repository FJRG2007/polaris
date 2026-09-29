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

import type { Locale } from "./locales.js";
import { IntlMessageFormat, type PrimitiveType } from "intl-messageformat";

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
     *  something a reader sees. */
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

function formatterFor(locale: Locale, message: string): IntlMessageFormat {
    const cacheKey = `${locale}\u0000${message}`;
    const found = formats.get(cacheKey);
    if (found) return found;
    const created = new IntlMessageFormat(message, locale);
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

/** The message at a dotted path, or undefined when the path does not end on one. */
export function lookupMessage(catalog: Catalog | undefined, key: string): string | undefined {
    let node: string | Catalog | undefined = catalog;
    for (const part of key.split(".")) {
        if (node === undefined || typeof node === "string" || !Object.hasOwn(node, part)) return undefined;
        node = node[part];
    }
    return typeof node === "string" ? node : undefined;
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
        const result = formatterFor(locale, message).format(params as Record<string, PrimitiveType>);
        return Array.isArray(result) ? result.join("") : String(result);
    } catch (caught) {
        onProblem({ kind: "format", locale, key, detail: caught instanceof Error ? caught.message : undefined });
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
        const result = formatterFor(locale, message).format<R>(
            params as Record<string, PrimitiveType | R | RichTag<R>>
        );
        return Array.isArray(result) ? result : [result];
    } catch (caught) {
        onProblem({ kind: "format", locale, key, detail: caught instanceof Error ? caught.message : undefined });
        return [message];
    }
}

export interface TranslatorOptions {
    /** Prefixed to every key in what is reported, so a problem names the file it
     *  is in. */
    readonly namespace?: string;
    /** Where problems go. Logged once per key by default. */
    readonly onProblem?: (problem: MessageProblem) => void;
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

    const translate = ((key: string, params?: MessageParams) => {
        const message = resolve(key);
        if (message === undefined) return qualified(key);
        return formatMessage(locale, message, params, onProblem, qualified(key));
    }) as unknown as Translator<MessageKey<T>>;

    translate.rich = <R>(key: string, params: RichParams<R>) => {
        const message = resolve(key);
        if (message === undefined) return [qualified(key)];
        return formatRich(locale, message, params, onProblem, qualified(key));
    };
    translate.has = (key: string): key is MessageKey<T> => lookupMessage(catalog, key) !== undefined;
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

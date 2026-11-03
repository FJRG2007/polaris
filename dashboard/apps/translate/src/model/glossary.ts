/**
 * Glossaries, as DeepL has them: per language pair, how a term is to come
 * out, plus the words never to translate at all. One function applies them
 * for every mode and every engine: each term found is swapped for a numbered
 * placeholder the engines carry through untouched, and the placeholder is
 * swapped back for the wanted wording once the translation is in.
 *
 * Pure, so the round trip is asserted in a test.
 */

import { z } from "zod";
import { languageCode } from "./schemas";

/** The most glossaries one person keeps. */
export const GLOSSARIES_MAX = 50;
/** The most terms in one glossary. */
export const ENTRIES_MAX = 1000;
/** The most words on the never-translate list. */
export const KEEP_MAX = 500;
/** The longest term or translation of one. */
export const TERM_MAX = 200;
/** The longest glossary name. */
export const NAME_MAX = 80;

/** One normalizer for the form and the server: trimmed, inner spaces collapsed. */
export function normalizeTerm(raw: string): string {
    return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

const term = z
    .string()
    .transform(normalizeTerm)
    .pipe(z.string().min(1).max(TERM_MAX));

export const glossaryEntry = z.object({ source: term, target: term });
export type GlossaryEntry = z.infer<typeof glossaryEntry>;

/** Terms kept once each, compared without case; the later spelling wins. */
function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
    const seen = new Map<string, T>();
    for (const item of items) seen.set(key(item).toLocaleLowerCase(), item);
    return [...seen.values()];
}

export const glossaryInput = z
    .object({
        name: z
            .string()
            .transform(normalizeTerm)
            .pipe(z.string().min(1).max(NAME_MAX)),
        from: languageCode,
        to: languageCode,
        isDefault: z.boolean(),
        entries: z
            .array(glossaryEntry)
            .max(ENTRIES_MAX)
            .transform((entries) => unique(entries, (entry) => entry.source))
    })
    .refine((value) => value.from !== value.to, { path: ["to"], message: "same" });
export type GlossaryInput = z.infer<typeof glossaryInput>;

export const keepInput = z
    .array(term)
    .max(KEEP_MAX)
    .transform((terms) => unique(terms, (item) => item));

/** A stored list read whole, even one written by an older or broken version. */
export function readEntries(stored: unknown): GlossaryEntry[] {
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((item) => {
        const parsed = glossaryEntry.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    });
}

export function readTerms(stored: unknown): string[] {
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((item) => {
        const parsed = term.safeParse(item);
        return parsed.success ? [parsed.data] : [];
    });
}

/** What applies to one translation: the chosen glossary's terms and the keep list. */
export interface Terms {
    entries: readonly GlossaryEntry[];
    keep: readonly string[];
}

export function hasTerms(terms: Terms | null | undefined): terms is Terms {
    return !!terms && (terms.entries.length > 0 || terms.keep.length > 0);
}

/** A placeholder: a number in brackets no language writes, carried as is by every engine. */
const placeholder = (index: number) => `⟦${index}⟧`;
/** A placeholder as an engine may hand it back: spaced out, or with full-width digits. */
const PLACEHOLDER = /⟦\s*([0-9０-９]+)\s*⟧/g;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What a placeholder stands for: the wording to put back, or the original as found. */
type Slot = { kind: "entry"; target: string } | { kind: "keep" };

export interface Protected {
    texts: string[];
    /** What each placeholder replaced, by its number. */
    found: string[];
    slots: Slot[];
    /** Whether any term was found at all, for the "glossary used" mark. */
    used: boolean;
}

const key = (text: string) => text.replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * Each glossary term and kept word in `texts` swapped for a placeholder, in
 * one pass: a single pattern with the longest terms first, so "New York City"
 * is not caught as "New York", and a term is matched only as a whole word (no
 * letter or digit right before or after it), in any case.
 */
export function protect(texts: readonly string[], terms: Terms): Protected {
    const rules = new Map<string, Slot>();
    for (const entry of terms.entries) rules.set(key(entry.source), { kind: "entry", target: entry.target });
    // A kept word wins over a glossary entry for the same term.
    for (const word of terms.keep) rules.set(key(word), { kind: "keep" });
    const found: string[] = [];
    const slots: Slot[] = [];
    const sources = [...rules.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
    if (sources.length === 0) return { texts: [...texts], found, slots, used: false };
    const alternatives = sources.map((source) => escapeRegExp(source).replace(/ /g, "\\s+")).join("|");
    const pattern = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${alternatives})(?![\p{L}\p{N}])`, "giu");
    const out = texts.map((text) =>
        text.replace(pattern, (match) => {
            const slot = rules.get(key(match));
            if (!slot) return match;
            found.push(match);
            slots.push(slot);
            return placeholder(found.length - 1);
        })
    );
    return { texts: out, found, slots, used: found.length > 0 };
}

/** The wording for a found term: a kept word as it was written; a glossary term
 *  capitalized when the original started a sentence with a capital. */
function wordingFor(found: string, slot: Slot): string {
    if (slot.kind === "keep") return found;
    const { target } = slot;
    const first = Array.from(found)[0] ?? "";
    const capital = first !== first.toLocaleLowerCase() && first === first.toLocaleUpperCase();
    const letters = found.match(/\p{L}/gu) ?? [];
    const allCaps = letters.length > 1 && letters.every((letter) => letter !== letter.toLocaleLowerCase());
    if (allCaps) return target.toLocaleUpperCase();
    if (capital) return target.charAt(0).toLocaleUpperCase() + target.slice(1);
    return target;
}

/** The placeholders in translated `texts` swapped back for their wording. */
export function restore(texts: readonly string[], shielded: Protected): string[] {
    return texts.map((text) =>
        text.replace(PLACEHOLDER, (whole, digits: string) => {
            const index = Number(digits.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10)));
            const slot = shielded.slots[index];
            const found = shielded.found[index];
            return slot && found !== undefined ? wordingFor(found, slot) : whole;
        })
    );
}

/**
 * `translate` run on `texts` with `terms` applied: protected on the way in,
 * restored on the way out. `used` says whether a term was found.
 */
export async function withTerms<T extends { texts: string[] }>(
    texts: readonly string[],
    terms: Terms | null | undefined,
    translate: (texts: string[]) => Promise<T>
): Promise<T & { glossaryUsed: boolean }> {
    if (!hasTerms(terms)) return { ...(await translate([...texts])), glossaryUsed: false };
    const shielded = protect(texts, terms);
    const answer = await translate(shielded.texts);
    return { ...answer, texts: restore(answer.texts, shielded), glossaryUsed: shielded.used };
}

/** One CSV field, quoted when it has to be (RFC 4180). */
function csvField(value: string): string {
    // Semicolons and tabs too: the reader takes either as a separator.
    return /[",;\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A glossary as CSV: `source,target` per line, as DeepL imports it. */
export function toCsv(entries: readonly GlossaryEntry[]): string {
    const lines = entries.map((entry) => `${csvField(entry.source)},${csvField(entry.target)}`);
    return `${lines.join("\r\n")}\r\n`;
}

/** The rows of a CSV (RFC 4180: quoted fields, doubled quotes, CRLF or LF). */
function csvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    const body = text.replace(/^﻿/, "");
    for (let index = 0; index < body.length; index++) {
        const char = body[index]!;
        if (quoted) {
            if (char === '"' && body[index + 1] === '"') {
                field += '"';
                index++;
            } else if (char === '"') quoted = false;
            else field += char;
        } else if (char === '"' && field === "") quoted = true;
        else if (char === "," || char === ";" || char === "\t") {
            row.push(field);
            field = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && body[index + 1] === "\n") index++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else field += char;
    }
    if (field || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/**
 * The entries in a CSV someone chose: the first two columns of each row, a
 * header row (`source,target`) skipped, blank and invalid rows left out and
 * counted, and no more than ENTRIES_MAX taken.
 */
export function fromCsv(text: string): { entries: GlossaryEntry[]; skipped: number } {
    let skipped = 0;
    const entries: GlossaryEntry[] = [];
    for (const [index, row] of csvRows(text).entries()) {
        if (row.every((cell) => !cell.trim())) continue;
        if (index === 0 && /^(source|term|original)$/i.test((row[0] ?? "").trim())) continue;
        const parsed = glossaryEntry.safeParse({ source: row[0] ?? "", target: row[1] ?? "" });
        if (!parsed.success || entries.length >= ENTRIES_MAX) {
            skipped++;
            continue;
        }
        entries.push(parsed.data);
    }
    return { entries: unique(entries, (entry) => entry.source), skipped };
}

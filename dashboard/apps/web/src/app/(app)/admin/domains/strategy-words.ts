/**
 * The exposure strategies and approaches in the reader's words.
 *
 * `lib/domain-strategies` keeps each one's English, because the setup's server
 * side and the tests read it. The wizard says it through the `admin` catalog
 * instead, keyed by the same ids (camel case), with every list line numbered in
 * the order the English holds it - the same number of lines, which a test holds
 * the two to.
 */

import {
    APPROACH_META,
    STRATEGY_META,
    type ExposureApproach,
    type ExposureStrategy
} from "@/lib/domain-strategies";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type AdminWords = NamespaceTranslator<"admin">;

/** `own-domain` -> `ownDomain`, the form the catalog keys take. */
export function wordKey(id: string): string {
    return id.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

function say(t: AdminWords, key: string): string {
    return t(key as NamespaceKey<"admin">);
}

export interface StrategyWords {
    label: string;
    summary: string;
    dependency: string;
    requires: string[];
}

/** One strategy's words. */
export function strategyWords(t: AdminWords, id: ExposureStrategy): StrategyWords {
    const base = `domainsSetup.strategies.${wordKey(id)}`;
    return {
        label: say(t, `${base}.label`),
        summary: say(t, `${base}.summary`),
        dependency: say(t, `${base}.dependency`),
        requires: STRATEGY_META[id].requires.map((_, index) => say(t, `${base}.requires.${index}`))
    };
}

export interface ApproachWords {
    label: string;
    summary: string;
    pros: string[];
    cons: string[];
}

/** One approach's words. */
export function approachWords(t: AdminWords, id: ExposureApproach): ApproachWords {
    const base = `domainsSetup.approaches.${id}`;
    return {
        label: say(t, `${base}.label`),
        summary: say(t, `${base}.summary`),
        pros: APPROACH_META[id].pros.map((_, index) => say(t, `${base}.pros.${index}`)),
        cons: APPROACH_META[id].cons.map((_, index) => say(t, `${base}.cons.${index}`))
    };
}

/** The note an option carries, by the id the ranking gave it; the English as it
 *  came when there is none. */
export function strategyNote(t: AdminWords, option: { note?: string; noteId?: string }): string | undefined {
    if (!option.note) return undefined;
    return option.noteId ? say(t, `domainsSetup.notes.${option.noteId}`) : option.note;
}

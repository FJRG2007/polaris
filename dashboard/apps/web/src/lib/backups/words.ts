/**
 * What `lib/backups` names in English, in the reader's words: the kinds of thing
 * that can be protected and how often a plan runs. Keyed by the same ids the
 * service uses, so a kind or an interval a newer service adds shows as it was
 * named there.
 */

import { isResourceKind } from "@/lib/backups/kinds";
import { isBackupEvery } from "@/lib/backups/policy";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"backups">;

/** `polaris-database` -> `polarisDatabase`, the form the catalog keys take. */
function keyOf(id: string): string {
    return id.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

/** What a kind is called, or `fallback` for one this build has no words for. */
export function kindLabel(t: Words, kind: string, fallback = kind): string {
    return isResourceKind(kind) ? t(`kinds.${keyOf(kind)}.label` as NamespaceKey<"backups">) : fallback;
}

/** What a kind is, in a sentence. */
export function kindSummary(t: Words, kind: string, fallback = ""): string {
    return isResourceKind(kind) ? t(`kinds.${keyOf(kind)}.summary` as NamespaceKey<"backups">) : fallback;
}

/** A kind named mid-sentence, with whatever article the language puts before it. */
export function kindInSentence(t: Words, kind: string): string {
    return isResourceKind(kind) ? t(`kinds.${keyOf(kind)}.inSentence` as NamespaceKey<"backups">) : kind;
}

/** How often a plan runs. */
export function everyLabel(t: Words, every: string): string {
    return isBackupEvery(every) ? t(`every.${keyOf(every)}` as NamespaceKey<"backups">) : every;
}

/**
 * The glossaries as the screen applies them: which one a translation uses,
 * and its terms fetched once per version and kept for the visit.
 */

import type { Terms } from "../model/glossary";
import { readCache, unwrap, writeCache } from "./i18n";
import type { GlossarySummary } from "../lib/glossary";
import { useCallback, useEffect, useRef, useState } from "react";
import { glossariesAction, glossaryAction } from "../actions/translate";

/**
 * The glossary a translation from `from` into `to` uses: the pair's default.
 * With the source not known yet (detection has not answered), the target's
 * default only when exactly one pair into it has one, so a guess never picks
 * between two.
 */
export function chooseGlossary(
    glossaries: readonly GlossarySummary[],
    from: string | null,
    to: string
): GlossarySummary | null {
    const defaults = glossaries.filter((glossary) => glossary.isDefault && glossary.to === to);
    if (from) return defaults.find((glossary) => glossary.from === from) ?? null;
    return defaults.length === 1 ? defaults[0]! : null;
}

export interface Shelf {
    glossaries: GlossarySummary[];
    keep: string[];
}

/** What a translation applies, and the glossary's name for the "glossary used" mark. */
export interface Applied {
    terms: Terms | null;
    name: string | null;
}

/**
 * The person's glossaries and keep list, last visit's first and then the
 * server's; `termsFor` the terms for one pair, each glossary's fetched once
 * per change.
 */
export function useGlossaries(): {
    shelf: Shelf | null;
    termsFor: (from: string | null, to: string) => Promise<Applied>;
} {
    const [shelf, setShelf] = useState<Shelf | null>(() => readCache<Shelf>("glossaries"));
    const fetched = useRef(new Map<string, Promise<Terms["entries"]>>());

    useEffect(() => {
        void unwrap(() => glossariesAction(), "")
            .then((answer) => {
                const fresh = { glossaries: answer.glossaries, keep: answer.keep };
                setShelf(fresh);
                writeCache("glossaries", fresh);
            })
            // A translation without glossaries is still a translation.
            .catch(() => setShelf((current) => current ?? { glossaries: [], keep: [] }));
    }, []);

    const termsFor = useCallback(
        async (from: string | null, to: string): Promise<Applied> => {
            const keep = shelf?.keep ?? [];
            const chosen = shelf ? chooseGlossary(shelf.glossaries, from, to) : null;
            if (!chosen) return { terms: keep.length ? { entries: [], keep } : null, name: null };
            const version = `${chosen.id}:${chosen.updatedAt}`;
            let entries = fetched.current.get(version);
            if (!entries) {
                entries = unwrap(() => glossaryAction({ id: chosen.id }), "").then(
                    (answer) => answer.glossary.entries
                );
                fetched.current.set(version, entries);
                // A failed fetch is asked again next time, not remembered.
                entries.catch(() => fetched.current.delete(version));
            }
            try {
                return { terms: { entries: await entries, keep }, name: chosen.name };
            } catch {
                return { terms: keep.length ? { entries: [], keep } : null, name: null };
            }
        },
        [shelf]
    );

    return { shelf, termsFor };
}

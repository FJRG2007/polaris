/**
 * The popup's words, in the reader's language.
 *
 * The language is read before the first paint (`main.tsx` waits the few
 * milliseconds storage takes) so the popup never opens in one language and
 * switches to another under somebody's eyes, and it is followed while the popup
 * is open: connecting an account whose language is another redraws in it.
 *
 * A component rendered with no provider - a test drawing one piece on its own -
 * speaks the browser's language, which is English wherever nothing says otherwise.
 */

import type { Locale } from "@polaris/core";
import { speakRepliesIn } from "@/lib/messages";
import { pickLocale, wordsIn, type Words } from "@/lib/words";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const WordsContext = createContext<Words>(wordsIn(pickLocale(null)));

export function WordsProvider({
    initial,
    follow,
    children
}: {
    initial: Locale;
    /** Calls back with the account's stored language whenever it changes, and
     *  returns what stops it. Handed in by the entrypoint, which is what reads
     *  browser storage - so this module can be drawn in a test. */
    follow: (onChange: (stored: string | null) => void) => () => void;
    children: ReactNode;
}): React.JSX.Element {
    const [words, setWords] = useState(() => {
        const first = wordsIn(initial);
        speakRepliesIn(first);
        return first;
    });
    useEffect(
        () =>
            follow((stored) => {
                const next = wordsIn(pickLocale(stored));
                speakRepliesIn(next);
                setWords(next);
            }),
        [follow]
    );
    return <WordsContext.Provider value={words}>{children}</WordsContext.Provider>;
}

/** The words to draw with. */
export function useWords(): Words {
    return useContext(WordsContext);
}

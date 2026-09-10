/**
 * Which `once` notices are the second announcement of something already shown.
 * Pure, for the tests.
 *
 * The announcer is the part of a notice's tag before its first colon:
 * `deploy:<deployment>` for a push window, `notification:<alert>` for the
 * dashboard's feed. A notice is a repeat only when the other announcer said the
 * same words a moment ago, and that match is spent on it. The same words from
 * the same announcer are another event, and so is a third notice after a pair.
 */

/** How long the words of a `once` notice wait for the other announcer's. */
export const ONCE_MS = 2 * 60_000;

export class OnceNotices {
    private readonly said = new Map<string, { readonly announcer: string; readonly at: number }>();

    constructor(private readonly now: () => number = Date.now) {}

    /** Whether this notice repeats one just shown, remembering it when it does not. */
    repeated(tag: string, words: string): boolean {
        const now = this.now();
        for (const [text, entry] of this.said) if (now - entry.at > ONCE_MS) this.said.delete(text);
        const announcer = tag.split(":", 1)[0] ?? tag;
        const earlier = this.said.get(words);
        if (earlier && earlier.announcer !== announcer) {
            this.said.delete(words);
            return true;
        }
        this.said.set(words, { announcer, at: now });
        return false;
    }
}

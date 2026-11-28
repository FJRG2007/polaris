/**
 * The last answer to a slow look, kept per key, so a screen that opens reads
 * what the app already knows instead of asking the machine again. A look is
 * made only when nothing is known yet (one at a time per key: a second asker
 * waits on the same one) or when the caller says something changed (`fresh`).
 */
export function createLastKnown<T>() {
    const kept = new Map<string, T>();
    const looking = new Map<string, Promise<T>>();

    function fresh(key: string, look: () => Promise<T>): Promise<T> {
        const running = looking.get(key);
        if (running) return running;
        const asked = look()
            .then((value) => {
                kept.set(key, value);
                return value;
            })
            .finally(() => {
                if (looking.get(key) === asked) looking.delete(key);
            });
        looking.set(key, asked);
        return asked;
    }

    return {
        /** What is known, or one look when nothing is. */
        read(key: string, look: () => Promise<T>): Promise<T> {
            return kept.has(key) ? Promise.resolve(kept.get(key) as T) : fresh(key, look);
        },
        /** Look again now and keep the answer: something changed, or a person asked. */
        fresh,
        /** What is known, without looking; null when nothing is yet. */
        known: (key: string): T | null => (kept.has(key) ? (kept.get(key) as T) : null),
        forget(key: string): void {
            kept.delete(key);
        }
    };
}

export type LastKnown<T> = ReturnType<typeof createLastKnown<T>>;

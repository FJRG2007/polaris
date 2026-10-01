/**
 * Work that has to wait for whatever is already running under the same key, and
 * runs whether that failed or not. Each call to `keyedTurns` is its own set of
 * queues; a key with nothing waiting holds no memory.
 */
export function keyedTurns(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
    const turns = new Map<string, Promise<unknown>>();
    return (key, work) => {
        const before = turns.get(key) ?? Promise.resolve();
        const turn = before.catch(() => undefined).then(work);
        const settled = turn.catch(() => undefined);
        turns.set(key, settled);
        void settled.then(() => {
            if (turns.get(key) === settled) turns.delete(key);
        });
        return turn;
    };
}

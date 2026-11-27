/**
 * Work over a list that grows with a space, done a few at a time.
 *
 * `Promise.all` over every member of a large space is as many queries in flight
 * as there are people, which exhausts the connection pool long before it
 * finishes. This runs at most `concurrency` of them at once and keeps the
 * answers in the order the items came in.
 */
export async function inBatches<T, R>(
    items: readonly T[],
    concurrency: number,
    run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const lane = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await run(items[index] as T, index);
        }
    };
    const lanes = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: lanes }, lane));
    return results;
}

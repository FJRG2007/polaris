/**
 * One voice per person, however many microphones they have on the connection.
 *
 * A person is heard through one `<audio>` element that plays every audio track
 * of theirs, so two microphone publications from one person are that person
 * twice. It happened: publishing is asked for from several places - joining,
 * changing the noise filter, picking another device, the repair after a failed
 * publish - and each asked "is there a microphone up yet?" before the other had
 * finished putting one up, so both did. With the noise filter on, the two are
 * the raw microphone and the filtered one a few milliseconds behind it, and a
 * voice played against a slightly late copy of itself is what a big empty room
 * sounds like. Only the people whose browser had raced were affected, which is
 * why it was "some users".
 *
 * Both ends are closed: publishing is one at a time per source and cleans up
 * after itself (`serialized`, `extraPublications`), and a listener plays only
 * the newest microphone of each person (`oneVoice`) - so somebody on an older
 * tab, still sending two, is heard once.
 */

/** A publication as far as choosing between them goes. */
export interface PublishedTrack<T> {
    readonly source: string;
    readonly kind: string;
    readonly track: T;
}

/**
 * The tracks to play for one person: everything, except that of several
 * microphone tracks only the last - the newest, since a participant lists its
 * publications in the order they arrived - is kept.
 */
export function oneVoice<T>(tracks: readonly PublishedTrack<T>[], microphone: string): T[] {
    const voices = tracks.filter((one) => one.source === microphone && one.kind === "audio");
    const newest = voices.at(-1);
    return tracks
        .filter((one) => !(one.source === microphone && one.kind === "audio") || one === newest)
        .map((one) => one.track);
}

/**
 * The publications of `source` other than `keep`: what is left on the
 * connection from a publish that raced this one, and has to come down.
 */
export function extraPublications<P extends { readonly source: string }>(
    publications: Iterable<P>,
    source: string,
    keep: P | undefined
): P[] {
    return [...publications].filter((one) => one.source === source && one !== keep);
}

/**
 * How long a turn waits for the one before it. A publish that never settles
 * must not leave everybody after it waiting for ever - a voice that cannot be
 * put back up is worse than the rare duplicate this guards against - so past
 * this the next one goes anyway, and the sweep after it tidies what is left.
 */
export const TURN_WAIT_MS = 20_000;

/**
 * Run `work` after every earlier piece of work under the same key has finished,
 * whether it succeeded or not, or once it has waited `waitMs`. What makes "is
 * there one up yet?" a question with a true answer: nobody else is halfway
 * through putting one up while it is asked.
 */
export function serialized(
    waitMs: number = TURN_WAIT_MS
): <T>(key: string, work: () => Promise<T>) => Promise<T> {
    const tails = new Map<string, Promise<unknown>>();
    return <T>(key: string, work: () => Promise<T>): Promise<T> => {
        const previous = tails.get(key);
        const before = previous
            ? Promise.race([previous, new Promise((resolve) => setTimeout(resolve, waitMs))])
            : Promise.resolve();
        const run = before.then(work, work);
        const tail = run.catch(() => undefined);
        tails.set(key, tail);
        void tail.then(() => {
            if (tails.get(key) === tail) tails.delete(key);
        });
        return run;
    };
}

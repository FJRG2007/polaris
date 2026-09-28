/**
 * Which channels one person's live streams deliver, resolved once per person.
 *
 * Every tab somebody has open holds its own stream, and every stream used to
 * hold its own copy of this answer. The copies were never different - it is one
 * question about one account - but each was asked for separately: somebody
 * with five tabs open was five reads every time a message landed in a room they
 * are not in and their answer was older than the TTL. On a busy instance that
 * is most messages and most people.
 *
 * So the answer lives here, keyed by account, for as long as any of that
 * account's streams is open, and a resolution in flight is joined rather than
 * repeated. The TTL and what forces a fresh answer are the stream's to decide,
 * exactly as they were: this only makes sure a decision taken by one tab is not
 * taken again by the four beside it.
 */

import { reachableChannelIds, type ChatActor } from "./access";

interface Scope {
    reachable: Set<string>;
    /** When the answer above was read. Zero is never, or "ask again". */
    resolvedAt: number;
    /** Bumped by every invalidation, so a resolution that started before one
     *  is known not to answer it. */
    generation: number;
    /** What caused the last invalidation. Every one of this person's streams
     *  is handed the same change and invalidates for it; only the first of
     *  them is a new reason to ask again. */
    cause: object | null;
    /** The resolution in flight, and the generation it started in. */
    resolving: { promise: Promise<void>; generation: number } | null;
    /** How many open streams are holding this. The entry goes with the last. */
    holders: number;
}

const scopes = new Map<string, Scope>();

export interface StreamScope {
    /** The channels as of the last resolution. */
    reachable(): ReadonlySet<string>;
    /** When that was, in epoch milliseconds; zero if it is to be asked again. */
    resolvedAt(): number;
    /** Mark the answer stale, for every stream this person has open, because
     *  of this change. The same change arriving at their other tabs is one
     *  invalidation, not one per tab. */
    invalidate(cause: object): void;
    /** Resolve again, joining one already running. A failure keeps the previous
     *  answer: the next event past the TTL tries again. */
    refresh(): Promise<void>;
    /** This stream is closing. */
    release(): void;
}

/** Take hold of the answer for this account, for one stream. */
export function holdStreamScope(actor: ChatActor): StreamScope {
    let scope = scopes.get(actor.id);
    if (!scope) {
        scope = {
            reachable: new Set(),
            resolvedAt: 0,
            generation: 0,
            cause: null,
            resolving: null,
            holders: 0
        };
        scopes.set(actor.id, scope);
    }
    scope.holders += 1;
    const held = scope;
    let released = false;

    return {
        reachable: () => held.reachable,
        resolvedAt: () => held.resolvedAt,
        invalidate: (cause) => {
            held.resolvedAt = 0;
            if (held.cause === cause) return;
            held.cause = cause;
            held.generation += 1;
        },
        refresh: () => {
            // Joined only when it started after the last invalidation. One that
            // was already running when somebody was added to a room may have
            // read the rows from before, and a tab told "channels" on the
            // strength of it would go on missing that room until the TTL.
            if (held.resolving && held.resolving.generation === held.generation) {
                return held.resolving.promise;
            }
            const before = held.resolving?.promise ?? Promise.resolve();
            const promise: Promise<void> = before
                .then(() => reachableChannelIds(actor))
                .then((reachable) => {
                    held.reachable = reachable;
                    held.resolvedAt = Date.now();
                })
                .catch(() => {
                    // A transient database error leaves the previous answer in
                    // place; the next event past the TTL tries again.
                })
                .finally(() => {
                    if (held.resolving?.promise === promise) held.resolving = null;
                });
            held.resolving = { promise, generation: held.generation };
            return promise;
        },
        release: () => {
            if (released) return;
            released = true;
            held.holders -= 1;
            if (held.holders <= 0 && scopes.get(actor.id) === held) scopes.delete(actor.id);
        }
    };
}

/** How many accounts have an answer held. For tests. */
export function heldStreamScopes(): number {
    return scopes.size;
}

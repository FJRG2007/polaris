/**
 * An in-memory calendar provider for the sync engine tests: calendars, objects
 * with etags, a change log that sync tokens index into, tokens that expire
 * (410), writes refused on a stale `If-Match` (412), deletions, and a failure
 * that can be set per operation. It speaks the engine's `CalendarProvider`
 * directly, so the tests exercise the sync engine rather than a protocol client
 * (those have their own tests against fake servers).
 */

import {
    SyncConflictError,
    SyncGoneError,
    SyncNotFoundError
} from "@polaris-app/calendar/src/lib/sync/errors";
import type {
    ChangeSet,
    CalendarProvider,
    PullState,
    RemoteCalendar
} from "@polaris-app/calendar/src/lib/sync/provider";

interface Stored {
    etag: string;
    ics: string;
    seq: number;
}

export interface Write {
    readonly op: "put" | "remove";
    readonly remoteId: string;
    readonly href: string | null;
    /** The `If-Match` the engine sent. */
    readonly ifMatch: string | null;
}

type Operation = "list" | "pull" | "put" | "remove";

export function createFakeProvider() {
    let seq = 0;
    let etags = 0;
    const calendars: RemoteCalendar[] = [];
    const objects = new Map<string, Map<string, Stored>>();
    const removed = new Map<string, Map<string, number>>();
    const expired = new Set<string>();
    const failing = new Map<Operation, Error>();
    const writes: Write[] = [];
    const pulls: PullState[] = [];
    let gate: Promise<void> | null = null;

    const collection = (remoteId: string) => {
        let found = objects.get(remoteId);
        if (!found) {
            found = new Map();
            objects.set(remoteId, found);
            removed.set(remoteId, new Map());
        }
        return found;
    };
    const nextEtag = () => `"etag-${++etags}"`;
    const fail = (operation: Operation) => {
        const error = failing.get(operation);
        if (error) throw error;
    };

    const provider: CalendarProvider = {
        async listCalendars() {
            fail("list");
            return calendars.map((calendar) => ({
                ...calendar,
                components: [...calendar.components]
            }));
        },
        async pull(state: PullState): Promise<ChangeSet> {
            pulls.push({ ...state, known: new Map(state.known) });
            fail("pull");
            if (state.syncToken && expired.has(state.syncToken))
                throw new SyncGoneError("The sync token expired", 410);
            const held = collection(state.remoteId);
            const token = `token-${seq}`;
            if (!state.syncToken) {
                return {
                    changed: [...held.entries()].map(([href, object]) => ({
                        href,
                        etag: object.etag,
                        ics: object.ics
                    })),
                    removed: [],
                    syncToken: token,
                    ctag: token,
                    full: true
                };
            }
            const since = Number(state.syncToken.replace("token-", ""));
            return {
                changed: [...held.entries()]
                    .filter(([, object]) => object.seq > since)
                    .map(([href, object]) => ({ href, etag: object.etag, ics: object.ics })),
                removed: [...(removed.get(state.remoteId)?.entries() ?? [])]
                    .filter(([, at]) => at > since)
                    .map(([href]) => href),
                syncToken: token,
                ctag: token,
                full: false
            };
        },
        async put(target, object) {
            writes.push({
                op: "put",
                remoteId: target.remoteId,
                href: object.href,
                ifMatch: object.etag
            });
            if (gate) await gate;
            fail("put");
            const held = collection(target.remoteId);
            const href = object.href ?? `${object.uid}.ics`;
            const existing = held.get(href);
            if (existing && object.etag !== existing.etag) throw new SyncConflictError();
            const etag = nextEtag();
            held.set(href, { etag, ics: object.ics, seq: ++seq });
            removed.get(target.remoteId)?.delete(href);
            return { href, etag };
        },
        async remove(target, object) {
            writes.push({
                op: "remove",
                remoteId: target.remoteId,
                href: object.href,
                ifMatch: object.etag
            });
            fail("remove");
            const held = collection(target.remoteId);
            const existing = held.get(object.href);
            if (!existing) throw new SyncNotFoundError("Not found on the server", 404);
            if (object.etag && object.etag !== existing.etag) throw new SyncConflictError();
            held.delete(object.href);
            removed.get(target.remoteId)?.set(object.href, ++seq);
        }
    };

    return {
        provider,
        writes,
        pulls,
        addCalendar(calendar: Partial<RemoteCalendar> & { remoteId: string; name: string }) {
            calendars.push({
                color: null,
                description: "",
                timezone: null,
                readOnly: false,
                components: ["VEVENT"],
                ...calendar
            });
            collection(calendar.remoteId);
        },
        /** A change made at the provider by somebody else. */
        remoteWrite(remoteId: string, href: string, ics: string): string {
            const etag = nextEtag();
            collection(remoteId).set(href, { etag, ics, seq: ++seq });
            return etag;
        },
        /** A deletion made at the provider, reported to later incremental pulls. */
        remoteDelete(remoteId: string, href: string) {
            collection(remoteId).delete(href);
            removed.get(remoteId)?.set(href, ++seq);
        },
        /** A deletion no incremental pull will report - only a full one shows it gone. */
        forget(remoteId: string, href: string) {
            collection(remoteId).delete(href);
        },
        object(remoteId: string, href: string): Stored | undefined {
            return collection(remoteId).get(href);
        },
        expire(token: string) {
            expired.add(token);
        },
        failOn(operation: Operation, error: Error | null) {
            if (error) failing.set(operation, error);
            else failing.delete(operation);
        },
        /** Hold every put until the returned function is called. */
        holdPuts(): () => void {
            let release = () => undefined as void;
            gate = new Promise<void>((resolve) => {
                release = () => {
                    gate = null;
                    resolve();
                };
            });
            return release;
        }
    };
}

export type FakeProvider = ReturnType<typeof createFakeProvider>;

/**
 * "Something about this session changed", inside this process.
 *
 * The session page holds a stream open on this and reloads what it shows when
 * it fires, instead of asking every few seconds. Frames carry nothing: the page
 * reads the session again through the same checks its first render used. A
 * change made by another process is not seen here, which is why the page keeps
 * a slow poll underneath the stream.
 */

import { EventEmitter } from "node:events";

const hub = new EventEmitter();
// One listener per open session page; the default ceiling of ten is a warning
// about a leak this is not.
hub.setMaxListeners(0);

/** Tell every open page of this session to read it again. */
export function touchSession(sessionId: string): void {
    hub.emit(sessionId);
}

/** Be told when the session changes. Returns the unsubscribe. */
export function subscribeSession(sessionId: string, listener: () => void): () => void {
    hub.on(sessionId, listener);
    return () => {
        hub.off(sessionId, listener);
    };
}

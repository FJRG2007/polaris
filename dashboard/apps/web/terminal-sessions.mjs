/**
 * Long-lived server shells for the terminal sidecar.
 *
 * A server terminal used to be one SSH channel per WebSocket: closing the tab,
 * reloading, or a dropped connection ended the shell and whatever was running in
 * it. Here the sidecar owns the channel instead, and a socket only attaches to
 * it. Output keeps flowing into a bounded scrollback buffer while nobody is
 * watching, and attaching again replays that buffer before the live stream - the
 * "reconnecting PTY" technique Coder's agent uses (a server-held PTY keyed by an
 * id, a ring buffer replayed on reconnect, ended after a period detached).
 *
 * It is chosen over a tmux/screen session on the server because it needs
 * nothing installed there: a registered server is any machine with SSH, and the
 * shell has to survive a closed tab on all of them. What it does not survive is
 * the sidecar itself restarting, which happens when Polaris is updated.
 *
 * Every session has a designed end: its shell exiting, an explicit close, or
 * being left detached for longer than the idle limit. The limit counts from
 * when the last viewer left, not from the last output, so a job printing away in
 * a tab nobody returns to still ends. A user can hold at most
 * `cap` of them. Every lookup is scoped by the user who opened the session, so
 * one user never lists, attaches to, renames or closes another's.
 *
 * Pure apart from the streams it is handed, so the lifecycle is unit-tested.
 */

import { randomUUID } from "node:crypto";

/** Defaults used when the environment says nothing - an existing install never
 *  gets new variables, so these are the values that actually run. */
export const DEFAULT_SESSION_CAP = 10;
export const DEFAULT_IDLE_MINUTES = 60;
export const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;
export const MAX_NAME_LENGTH = 60;

/** A positive integer from the environment, or the fallback. */
export function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** A session name as stored: trimmed, control characters dropped, bounded.
 *  Empty means "use the default name", which the client numbers. */
export function cleanName(value) {
    if (typeof value !== "string") return null;
    const name = value
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, MAX_NAME_LENGTH);
    return name || null;
}

/**
 * @param {{ cap?: number, idleMs?: number, scrollbackBytes?: number, now?: () => number }} [options]
 */
export function createSessionRegistry(options = {}) {
    const cap = options.cap ?? DEFAULT_SESSION_CAP;
    const idleMs = options.idleMs ?? DEFAULT_IDLE_MINUTES * 60_000;
    const scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    const now = options.now ?? Date.now;
    /** @type {Map<string, any>} */
    const sessions = new Map();
    /** Next default number per user and server, so "Shell 3" stays "Shell 3"
     *  after "Shell 2" is closed. */
    const counters = new Map();

    const countFor = (userId) => {
        let n = 0;
        for (const s of sessions.values()) if (s.userId === userId) n += 1;
        return n;
    };

    function append(session, chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        session.chunks.push(buf);
        session.size += buf.length;
        while (session.size > scrollbackBytes && session.chunks.length > 1) {
            session.size -= session.chunks.shift().length;
        }
        if (session.size > scrollbackBytes) {
            // One chunk larger than the whole buffer: keep its tail.
            const only = session.chunks[0];
            session.chunks[0] = only.subarray(only.length - scrollbackBytes);
            session.size = scrollbackBytes;
        }
    }

    function end(session, code = 1000, reason = "") {
        if (!sessions.delete(session.id)) return;
        const sink = session.sink;
        session.sink = null;
        try {
            session.close();
        } catch {
            // Already gone; ending it is what was asked for either way.
        }
        sink?.close(code, reason);
    }

    return {
        cap,
        idleMs,

        /** How many sessions this user holds, on every server. */
        count(userId) {
            return countFor(userId);
        },

        /** Whether this user may open another session, under the cap the web
         *  app sent with the ticket or, from an older one, the default. */
        canOpen(userId, limit) {
            const ceiling = Number.isInteger(limit) && limit >= 1 ? limit : cap;
            return countFor(userId) < ceiling;
        },

        /**
         * Register a freshly opened shell. `stream` emits data/close/error;
         * `close` tears the channel down; `resize` forwards a window change.
         */
        add({ userId, hostId, mode, stream, resize, close }) {
            const counterKey = `${userId}\u0000${hostId}`;
            const number = (counters.get(counterKey) ?? 0) + 1;
            counters.set(counterKey, number);
            const session = {
                id: randomUUID(),
                userId,
                hostId,
                mode,
                number,
                name: null,
                createdAt: now(),
                lastActiveAt: now(),
                // Detached from birth until the opening socket attaches.
                detachedAt: now(),
                chunks: [],
                size: 0,
                sink: null,
                stream,
                resize,
                close
            };
            sessions.set(session.id, session);
            stream.on("data", (chunk) => {
                append(session, chunk);
                session.lastActiveAt = now();
                session.sink?.send(chunk);
            });
            stream.on("close", () => end(session));
            stream.on("error", () => end(session));
            return session;
        },

        /** A session this user opened on this server in this mode, or null -
         *  the same null for "gone" and "somebody else's". */
        find(userId, hostId, mode, id) {
            const session = sessions.get(id);
            if (!session || session.userId !== userId) return null;
            if (session.hostId !== hostId || session.mode !== mode) return null;
            return session;
        },

        /**
         * Attach a viewer. One viewer at a time: a second attach takes the
         * session over, and the first is told so rather than left typing into a
         * shell somebody else is now driving. Returns the scrollback to replay.
         */
        attach(session, sink) {
            const previous = session.sink;
            session.sink = sink;
            session.detachedAt = null;
            session.lastActiveAt = now();
            previous?.close(4007, "session opened elsewhere");
            return Buffer.concat(session.chunks);
        },

        /** The viewer went away; the shell keeps running. */
        detach(session, sink) {
            if (session.sink !== sink) return;
            session.sink = null;
            session.detachedAt = now();
        },

        input(session, data) {
            session.lastActiveAt = now();
            session.stream.write(data);
        },

        /** This user's sessions on one server, oldest first. */
        list(userId, hostId) {
            return [...sessions.values()]
                .filter((s) => s.userId === userId && s.hostId === hostId)
                .sort((a, b) => a.createdAt - b.createdAt || a.number - b.number)
                .map((s) => ({
                    id: s.id,
                    name: s.name,
                    number: s.number,
                    mode: s.mode,
                    createdAt: new Date(s.createdAt).toISOString(),
                    lastActiveAt: new Date(s.lastActiveAt).toISOString(),
                    attached: Boolean(s.sink)
                }));
        },

        rename(userId, hostId, id, name) {
            const session = sessions.get(id);
            if (!session || session.userId !== userId || session.hostId !== hostId) return false;
            session.name = cleanName(name);
            return true;
        },

        /** Explicit close by its owner. */
        close(userId, hostId, id) {
            const session = sessions.get(id);
            if (!session || session.userId !== userId || session.hostId !== hostId) return false;
            end(session, 4006, "session ended");
            return true;
        },

        /** End every session left detached past the idle limit. */
        sweep() {
            let ended = 0;
            const cutoff = now() - idleMs;
            for (const session of [...sessions.values()]) {
                if (!session.sink && session.detachedAt !== null && session.detachedAt <= cutoff) {
                    end(session);
                    ended += 1;
                }
            }
            return ended;
        },

        size() {
            return sessions.size;
        }
    };
}

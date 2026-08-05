/**
 * Telling the other people looking at a space that something moved.
 *
 * Work management is the one app here that is always somebody else's screen too:
 * a task assigned in one tab has to appear in the tab of the person it was
 * assigned to, without them reloading. Every write already funnels through one
 * `refresh()` in the actions layer, so that is where a change is announced, and
 * this is what it is announced to.
 *
 * The bus is in-process on purpose. Every writer lives in the same server -
 * the actions layer, the attachment route, the automations those actions run -
 * so there is nothing for a broker to carry between, and a Redis dependency for
 * one deployment that is a single container is a dependency to keep working
 * forever. If Polaris ever runs replicas this is the one module that has to
 * grow a transport; nothing above it changes.
 *
 * What travels is the fact that a space changed, never what changed in it. The
 * subscriber re-renders through the same server components and the same access
 * checks it loaded with, so a signal can never hand somebody a row they were
 * not already allowed to read.
 */

/** A change worth waking other screens for. */
export interface TaskChange {
    /** The space it happened in, or null when the write spans spaces (a bulk
     *  edit across a cross-space screen) and every listener should look again. */
    readonly spaceId: string | null;
    /** Who made it. A tab does not need waking for its own write - the action it
     *  called already revalidated - so the stream drops these for the actor. */
    readonly actorId: string;
}

type Listener = (change: TaskChange) => void;

/**
 * Held on globalThis rather than in a module binding. A dev server re-evaluates
 * a module on edit, and a fresh module-scoped Set would strand every connection
 * opened against the previous copy: the streams stay subscribed to a Set nothing
 * publishes into again.
 */
const REGISTRY = Symbol.for("polaris.tasks.live");

interface Registry {
    listeners: Set<Listener>;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    if (!holder[REGISTRY]) holder[REGISTRY] = { listeners: new Set() };
    return holder[REGISTRY];
}

/** Announce a change. Never throws: a listener that fails is one dead browser
 *  connection, and it must not turn somebody's successful write into an error. */
export function publishTaskChange(change: TaskChange): void {
    for (const listener of registry().listeners) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeTaskChanges(listener: Listener): () => void {
    const { listeners } = registry();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

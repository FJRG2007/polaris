/**
 * Telling an open tab that what it may reach has changed.
 *
 * Every app in the switcher, every entry in the rail and every screen behind
 * them is resolved on the server from the permissions the reader holds - so
 * granting somebody the Mail app, or taking Deploy back off them, changed
 * nothing on the screen they were looking at. They were told to reload, which
 * nobody does, or they went on seeing a switcher that lied until something else
 * happened to redraw the page.
 *
 * The same in-process bus Mail, Chat and Tasks use, for the same reason: every
 * writer that can change this is in this server. What travels is whose access
 * moved and nothing else - never a permission, never a role, never an app id. A
 * browser woken by it asks the server for the page again, through the same
 * session and the same checks that drew it, so a frame can never turn into an
 * app somebody was not granted.
 *
 * The stream also refuses to deliver a frame naming other people, which is a
 * second line rather than the reason this is safe.
 */

/** Something that may have changed what somebody reaches. */
export interface AccessChange {
    /**
     * Whose access moved.
     *
     * Empty - or absent - means it could be anybody's: a role was rewritten, a
     * policy changed, an app was installed or removed. Resolving the exact set
     * of people behind every one of those is a query per write and a chance to
     * be wrong, and the cost of being broad is a redraw of a page that already
     * looks the way it will look.
     */
    readonly userIds?: readonly string[];
}

type Listener = (change: AccessChange) => void;

/** Held on globalThis rather than in a module binding, because a dev server
 *  re-evaluates a module on edit and a fresh Set would strand every connection
 *  opened against the previous copy. */
const REGISTRY = Symbol.for("polaris.access.live");

interface Registry {
    listeners: Set<Listener>;
}

function registry(): Registry {
    const holder = globalThis as { [REGISTRY]?: Registry };
    if (!holder[REGISTRY]) holder[REGISTRY] = { listeners: new Set() };
    return holder[REGISTRY];
}

/**
 * Announce that somebody's access moved.
 *
 * Never throws and never awaited by the write that raised it: a listener that
 * fails is one dead browser connection, and it must not turn granting somebody
 * an app into an error on the administrator's screen.
 */
export function publishAccessChange(change: AccessChange = {}): void {
    for (const listener of registry().listeners) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeAccess(listener: Listener): () => void {
    const held = registry();
    held.listeners.add(listener);
    return () => {
        held.listeners.delete(listener);
    };
}

/** Whether a frame is this reader's business. A change that names nobody is
 *  everybody's, because the things that raise one - a role, a policy, an app
 *  arriving - are not about one person. */
export function concerns(change: AccessChange, userId: string): boolean {
    return !change.userIds || change.userIds.length === 0 || change.userIds.includes(userId);
}

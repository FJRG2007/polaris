"use client";

/**
 * What is waiting, by the app it is waiting in.
 *
 * One list, read by everything that draws a badge: the app switcher's entries,
 * the dot on the switcher itself, the rail, and the number on the tab icon. The
 * reason it exists is a bug rather than a tidiness: each of those places had
 * written out "chat, or mail" for itself, and when Mail learned to count, three
 * of them were taught and the fourth was not - so the switcher showed a number
 * against Mail and no dot to say a number was there, which is precisely the
 * thing a dot is for.
 *
 * Anything that adds a fifth place to look, or another app that can be waited
 * on, adds it here and every badge in Polaris follows. Nothing downstream is
 * allowed to name an app again - which is what made Management free: a queue
 * that had nowhere to be seen became a number on the switcher, the rail and the
 * tab icon by being counted here.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";
import { useChatUnread } from "@/components/chat-unread";
import { useMailUnread } from "@/components/mail-unread";
import { useAdminWaiting } from "@/components/admin-waiting";

/** How much is waiting in each app, by the id the app catalogue uses. Apps with
 *  nothing to count are simply absent rather than zero, so a caller can ask
 *  `?? 0` and be right either way. */
export type AppUnread = Readonly<Record<string, number>>;

/** The counts as the providers hold them, before anything this browser did. */
function useServerUnread(): AppUnread {
    const chat = useChatUnread();
    const mail = useMailUnread();
    // Management counts work rather than messages - a report nobody has settled,
    // an update nothing will install by itself - and that is the same question
    // this answers for the other two: is anybody waiting for me. See
    // `admin-waiting`.
    const admin = useAdminWaiting();
    return useMemo(
        () => ({ chat: chat.messages, mail: mail.messages, admin: admin.total }),
        [chat.messages, mail.messages, admin.total]
    );
}

/**
 * What this browser has just marked read, before the server has said so.
 *
 * The app menu marks entries read where the badge is, and a badge that stays at
 * its old number until the app's stream has gone round is a mark that looks
 * like it did nothing. So the menu moves the number at once, by app, and the
 * overlay goes the moment that app's own count moves - the same overlay Mail's
 * badge keeps, for the same reason and exactly as long. A mark the server
 * refused is moved back by the menu.
 */
const DriftContext = createContext<{
    readonly drift: Readonly<Record<string, number>>;
    readonly nudge: (app: string, by: number) => void;
}>({ drift: {}, nudge: () => undefined });

/** Moves an app's badge by what this screen has just done. Does nothing
 *  outside the provider. */
export function useNudgeAppUnread(): (app: string, by: number) => void {
    return useContext(DriftContext).nudge;
}

export function AppUnreadDriftProvider({ children }: { children: ReactNode }) {
    const server = useServerUnread();
    const [drift, setDrift] = useState<Record<string, number>>({});
    const seen = useRef(server);
    // An app's count moved on the server: whatever was laid over it is either
    // counted there now, or was never true.
    useEffect(() => {
        const before = seen.current;
        seen.current = server;
        setDrift((held) => {
            const moved = Object.keys(held).filter((app) => before[app] !== server[app]);
            if (moved.length === 0) return held;
            const next = { ...held };
            for (const app of moved) delete next[app];
            return next;
        });
    }, [server]);
    const nudge = useCallback((app: string, by: number) => {
        if (by === 0) return;
        setDrift((held) => ({ ...held, [app]: (held[app] ?? 0) + by }));
    }, []);
    const value = useMemo(() => ({ drift, nudge }), [drift, nudge]);
    return <DriftContext.Provider value={value}>{children}</DriftContext.Provider>;
}

/**
 * The counts, gathered.
 *
 * Both providers already hold their own number and both are above every screen,
 * so this costs nothing beyond the object it builds: no request, no stream, no
 * state of its own. What the app menu has just marked read is taken off at
 * once - see `AppUnreadDriftProvider`.
 */
export function useAppUnread(): AppUnread {
    const server = useServerUnread();
    const { drift } = useContext(DriftContext);
    return useMemo(() => {
        if (Object.keys(drift).length === 0) return server;
        return Object.fromEntries(
            Object.entries(server).map(([app, count]) => [
                app,
                Math.max(0, count + (drift[app] ?? 0))
            ])
        );
    }, [server, drift]);
}

/** Whether anything anywhere is waiting, which is the whole question a dot on
 *  the switcher answers. Derived rather than listed, so an app that starts
 *  counting raises it without anybody remembering to. */
export function anythingWaiting(unread: AppUnread): boolean {
    return Object.values(unread).some((count) => count > 0);
}

/** Everything waiting, as one number - for the tab icon, which has room for
 *  one. Which app it came from is a question the page itself answers. */
export function totalWaiting(unread: AppUnread): number {
    return Object.values(unread).reduce((sum, count) => sum + count, 0);
}

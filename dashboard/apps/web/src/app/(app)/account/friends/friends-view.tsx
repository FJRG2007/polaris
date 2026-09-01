"use client";

/**
 * Friends, and the two ways to gain one.
 *
 * Its own screen rather than a card under the privacy settings, because it is a
 * list of people that grows and a settings screen is a set of switches that does
 * not. What it is FOR still lives next door: "friends only" is the middle answer
 * to every question over there, and until this list has somebody in it that
 * answer means the same as "nobody".
 *
 * Being friends grants nothing. It is not a way into a conversation, a space or
 * a file - a relationship that also carried permissions would be two ideas
 * wearing one name.
 *
 * The list is a page at a time and loads the next as it is scrolled: this can be
 * empty and it can be thousands, and a screen that sends all of them is a screen
 * that works until somebody popular opens it. It also keeps itself current -
 * being accepted arrives as an alert, and a screen that showed the request still
 * pending underneath that alert is a screen people reload by hand.
 */

import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { useConfirm } from "@/components/confirm-dialog";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Search, UserMinus, UserPlus, X } from "lucide-react";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import type { FriendCursor, FriendRequestView, FriendView } from "@/lib/friends-service";
import {
    loadFriendsAction,
    removeFriendAction,
    requestFriendAction,
    loadFriendRequestsAction,
    requestFriendByUsernameAction,
    respondToRequestAction,
    searchPeopleAction
} from "../privacy/actions";

/** Below this nothing is asked at all - the floor the server keeps, said here
 *  too so the request is never made. */
const SHORTEST = 2;

/** How long the field sits still before it asks. */
const SEARCH_AFTER = 220;

/** The event a friend alert arrives as. The screen listens for this one rather
 *  than for any alert at all, so a deploy finishing does not reload a list of
 *  people. */
const FRIEND_EVENT = "account.friend";

export function FriendsView({
    friends,
    requests,
    more
}: {
    /** The first page, rendered by the server so the screen opens with people on
     *  it rather than with a spinner. */
    friends: readonly FriendView[];
    requests: readonly FriendRequestView[];
    /** Where that page ended, or null when it was the whole list. */
    more: FriendCursor | null;
}) {
    return <FriendsCard friends={friends} requests={requests} more={more} />;
}

function FriendsCard({
    friends,
    requests,
    more
}: {
    friends: readonly FriendView[];
    requests: readonly FriendRequestView[];
    more: FriendCursor | null;
}) {
    const [confirm, confirmElement] = useConfirm();
    const { items: alerts } = useNotificationFeed();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const [people, setPeople] = useState<readonly FriendView[]>(friends);
    const [waiting, setWaiting] = useState<readonly FriendRequestView[]>(requests);
    const [cursor, setCursor] = useState<FriendCursor | null>(more);
    const [loading, setLoading] = useState(false);

    // What the server sent last. A navigation back to this screen re-renders it
    // with a fresh first page, and the list has to take that rather than keep
    // showing the one it built up.
    useEffect(() => {
        setPeople(friends);
        setCursor(more);
    }, [friends, more]);
    useEffect(() => setWaiting(requests), [requests]);

    /**
     * Read the whole list again from the top.
     *
     * Used after anything that changes who is on it, including something that
     * happened on somebody else's screen. A page at a time is how it grows; this
     * is how it corrects itself, and it deliberately drops the pages already
     * loaded rather than trying to patch one row into the middle of them - a
     * name that moved is a name in a different page.
     */
    const reload = async () => {
        const [page, pending] = await Promise.all([
            loadFriendsAction(null),
            loadFriendRequestsAction()
        ]);
        setPeople(page.items);
        setCursor(page.cursor);
        setWaiting(pending.requests);
    };

    const act = async (run: () => Promise<{ error?: string }>) => {
        setBusy(true);
        setError("");
        const result = await runAction(run, setError);
        setBusy(false);
        if (result?.error) return;
        await reload();
    };

    /**
     * Follow the alerts.
     *
     * Being accepted arrives in the feed, which is already live and already
     * shared with the bell - so this screen has nothing of its own to connect.
     * The newest friend alert's id is what is watched: the same alert marked
     * read must not count as news, and re-reading the list on every feed tick
     * would be a query per second for a screen nobody is touching.
     */
    const newest = alerts.find((alert) => alert.type === FRIEND_EVENT)?.id ?? "";
    const seen = useRef(newest);
    useEffect(() => {
        if (!newest || newest === seen.current) return;
        seen.current = newest;
        void reload();
        // `reload` only ever calls setState and two actions, neither of which
        // this needs to re-run for.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [newest]);

    /** The next page, asked for when the end of the list comes into view. */
    const loadMore = async () => {
        if (loading || !cursor) return;
        setLoading(true);
        const page = await loadFriendsAction(cursor);
        setPeople((current) => {
            // The pages are read in order, but a reload can land between two of
            // them - so anybody already on the list is not added twice.
            const held = new Set(current.map((friend) => friend.id));
            return [...current, ...page.items.filter((friend) => !held.has(friend.id))];
        });
        setCursor(page.cursor);
        setLoading(false);
    };

    const askToRemove = async (friend: FriendView) => {
        const sure = await confirm({
            title: `Stop being friends with ${friend.name}?`,
            description:
                "They keep whatever else reaches them - a shared space, a conversation - and lose only what you show your friends. Either of you can ask again.",
            confirmLabel: "Stop being friends",
            danger: true
        });
        if (!sure) return;
        await act(() => removeFriendAction(friend.id));
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <AddFriend
                    exclude={people.map((friend) => friend.id)}
                    onAsk={(run) => void act(run)}
                />

                {waiting.length > 0 && (
                    <ul className="flex flex-col gap-1">
                        {waiting.map((request) => (
                            <li
                                key={request.id}
                                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                            >
                                <Avatar openable person={request.person} size={24} />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm">
                                        {request.person.name}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {request.outgoing ? "You asked them" : "Wants to be added"}
                                    </span>
                                </span>
                                {!request.outgoing && (
                                    <Button
                                        size="xs"
                                        disabled={busy}
                                        onClick={() =>
                                            void act(() => respondToRequestAction(request.id, true))
                                        }
                                    >
                                        <UserPlus className="size-3.5" />
                                        Accept
                                    </Button>
                                )}
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    disabled={busy}
                                    aria-label={request.outgoing ? "Withdraw" : "Turn down"}
                                    onClick={() =>
                                        void act(() => respondToRequestAction(request.id, false))
                                    }
                                >
                                    <X className="size-3.5" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}

                {people.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        Nobody yet. Until there is, &quot;friends only&quot; is the same as
                        &quot;nobody&quot;.
                    </p>
                ) : (
                    <>
                        <ul className="flex flex-col gap-1">
                            {people.map((friend) => (
                                <li
                                    key={friend.id}
                                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                                >
                                    <Avatar openable person={friend} size={24} />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm" title={friend.name}>
                                            {friend.name}
                                        </span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {friend.contact}
                                        </span>
                                    </span>
                                    <Button
                                        size="xs"
                                        variant="ghost"
                                        disabled={busy}
                                        aria-label={`Stop being friends with ${friend.name}`}
                                        title="Stop being friends"
                                        onClick={() => void askToRemove(friend)}
                                    >
                                        <UserMinus className="size-3.5" />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                        <MoreWhenSeen enabled={cursor !== null} loading={loading} onReach={loadMore}>
                            <Button size="sm" variant="ghost" onClick={() => void loadMore()} disabled={loading}>
                                {loading ? <Loader2 className="size-4 animate-spin" /> : null}
                                Show more
                            </Button>
                        </MoreWhenSeen>
                    </>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </CardBody>
            {confirmElement}
        </Card>
    );
}

/**
 * The foot of a list that loads itself.
 *
 * An observer rather than a scroll handler: the question is "is the end of the
 * list on screen", which is exactly what an intersection observer answers and
 * what a scroll listener has to work out for itself on every pixel. The button
 * inside stays, and not only as a fallback for a browser without the observer -
 * it is what somebody reaching the list by keyboard presses, and it is what says
 * there is more to come.
 */
function MoreWhenSeen({
    enabled,
    loading,
    onReach,
    children
}: {
    enabled: boolean;
    loading: boolean;
    onReach: () => void | Promise<void>;
    children: ReactNode;
}) {
    const foot = useRef<HTMLDivElement>(null);
    // Held in a ref so the observer is set up once per enabling rather than
    // re-created on every render of the list behind it.
    const reach = useRef(onReach);
    reach.current = onReach;

    useEffect(() => {
        const element = foot.current;
        if (!enabled || !element || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) void reach.current();
            },
            // A little before it is actually reached, so the next page is on its
            // way while there is still list left to read.
            { rootMargin: "240px" }
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, [enabled]);

    if (!enabled) return null;
    return (
        <div ref={foot} className="flex justify-center py-1">
            {loading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
                children
            )}
        </div>
    );
}

/**
 * One box.
 *
 * There were two, and the second was the tell: a search that only finds people
 * who allow themselves to be found, and beside it a field for the ones who do
 * not. Both of them "add somebody", and nobody arriving at this screen could
 * have said which was which.
 *
 * So it is one field and one question - name, email or username. What matches is
 * offered as it is typed; what does not can still be asked for by the exact
 * handle, which is the only thing somebody who has hidden themselves ever hands
 * out. The answer to that one is deliberately the same sentence whether or not
 * anybody was there: a different reply for a hit and a miss is a way to discover
 * which usernames exist by typing them one after another.
 */
function AddFriend({
    exclude,
    onAsk
}: {
    exclude: readonly string[];
    onAsk: (run: () => Promise<{ error?: string }>) => void;
}) {
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<readonly { id: string; name: string }[]>([]);
    const [looking, setLooking] = useState(false);
    const [said, setSaid] = useState("");
    const asked = useRef(0);

    useEffect(() => {
        const term = query.trim();
        const mine = ++asked.current;
        if (term.length < SHORTEST) {
            setFound([]);
            setLooking(false);
            return;
        }
        setLooking(true);
        const timer = setTimeout(async () => {
            const result = await searchPeopleAction(term);
            if (mine !== asked.current) return;
            setFound(result.results ?? []);
            setLooking(false);
        }, SEARCH_AFTER);
        return () => clearTimeout(timer);
    }, [query]);

    const offered = found.filter((person) => !exclude.includes(person.id));

    const askByHandle = async () => {
        const handle = query.trim();
        if (!handle) return;
        const result = await runAction(() => requestFriendByUsernameAction(handle), setSaid);
        if (result?.said) {
            setSaid(result.said);
            setQuery("");
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setSaid("");
                        }}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            void askByHandle();
                        }}
                        placeholder="Name, email or username"
                        aria-label="Add somebody"
                        className="pl-7"
                    />
                    {looking && (
                        <Loader2 className="absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                </div>
                <Button
                    variant="secondary"
                    disabled={!query.trim()}
                    onClick={() => void askByHandle()}
                    title="Ask by exact username"
                >
                    Ask
                </Button>
            </div>

            {offered.length > 0 && (
                <ul className="flex flex-col">
                    {offered.map((person) => (
                        <li key={person.id}>
                            <button
                                type="button"
                                onClick={() => {
                                    setQuery("");
                                    setSaid("");
                                    onAsk(() => requestFriendAction(person.id));
                                }}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                            >
                                <Avatar person={person} size={20} />
                                <span className="min-w-0 flex-1 truncate">{person.name}</span>
                                <UserPlus className="size-3.5 shrink-0 text-muted-foreground" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <span className="text-xs text-muted-foreground">
                {said ||
                    "Somebody who keeps themselves out of the search can still be asked, if they have given you their exact username."}
            </span>
        </div>
    );
}

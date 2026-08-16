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
 */

import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { useEffect, useRef, useState } from "react";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { Loader2, Search, UserMinus, UserPlus, X } from "lucide-react";
import type { FriendRequestView, FriendView } from "@/lib/friends-service";
import {
    removeFriendAction,
    requestFriendAction,
    requestFriendByUsernameAction,
    respondToRequestAction,
    searchPeopleAction
} from "../privacy/actions";

/** Below this nothing is asked at all - the floor the server keeps, said here
 *  too so the request is never made. */
const SHORTEST = 2;

/** How long the field sits still before it asks. */
const SEARCH_AFTER = 220;

export function FriendsView({
    friends,
    requests
}: {
    friends: readonly FriendView[];
    requests: readonly FriendRequestView[];
}) {
    return <FriendsCard friends={friends} requests={requests} />;
}

function FriendsCard({
    friends,
    requests
}: {
    friends: readonly FriendView[];
    requests: readonly FriendRequestView[];
}) {
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const act = async (run: () => Promise<{ error?: string }>) => {
        setBusy(true);
        setError("");
        await runAction(run, setError);
        setBusy(false);
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-4">
                <AddFriend
                    exclude={friends.map((friend) => friend.id)}
                    onAsk={(run) => void act(run)}
                />

                {requests.length > 0 && (
                    <ul className="flex flex-col gap-1">
                        {requests.map((request) => (
                            <li
                                key={request.id}
                                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                            >
                                <Avatar person={request.person} size={24} />
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

                {friends.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        Nobody yet. Until there is, &quot;friends only&quot; is the same as
                        &quot;nobody&quot;.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {friends.map((friend) => (
                            <li
                                key={friend.id}
                                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                            >
                                <Avatar person={friend} size={24} />
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
                                    onClick={() => void act(() => removeFriendAction(friend.id))}
                                >
                                    <UserMinus className="size-3.5" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </CardBody>
        </Card>
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

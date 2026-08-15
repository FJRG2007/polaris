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

import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { Loader2, UserMinus, UserPlus, X } from "lucide-react";
import type { FriendRequestView, FriendView } from "@/lib/friends-service";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { PeoplePicker, type PickedPerson } from "@/app/(app)/chat/people-picker";
import {
    removeFriendAction,
    requestFriendAction,
    requestFriendByUsernameAction,
    respondToRequestAction,
    searchForFriendAction
} from "../privacy/actions";

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
                <PeoplePicker
                    label="Ask somebody"
                    picked={[]}
                    max={1}
                    onChange={(picked: readonly PickedPerson[]) => {
                        const person = picked.at(-1);
                        if (person) void act(() => requestFriendAction(person.id));
                    }}
                    exclude={friends.map((friend) => friend.id)}
                    search={searchForFriendAction}
                />

                <ByUsername onDone={setError} />

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
                                            void act(() =>
                                                respondToRequestAction(request.id, true)
                                            )
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
                                    <span className="block truncate text-sm" title={friend.name}>{friend.name}</span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {friend.email}
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
 * Asking somebody who cannot be searched for.
 *
 * The other half of "nobody can find me": a username is handed out on purpose,
 * one person at a time, and this is what it is handed out for. The answer is the
 * same sentence whether or not anybody was there - anything else would be a way
 * to find out which usernames exist by typing them one after another.
 */
function ByUsername({ onDone }: { onDone: (message: string) => void }) {
    const [username, setUsername] = useState("");
    const [said, setSaid] = useState("");
    const [busy, setBusy] = useState(false);

    const ask = async () => {
        if (!username.trim()) return;
        setBusy(true);
        onDone("");
        const result = await runAction(() => requestFriendByUsernameAction(username), onDone);
        setBusy(false);
        if (result?.said) {
            setSaid(result.said);
            setUsername("");
        }
    };

    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
                Somebody who keeps themselves out of the search can still be asked, if they have
                given you their username.
            </span>
            <div className="flex items-center gap-2">
                <Input
                    value={username}
                    onChange={(event) => {
                        setUsername(event.target.value);
                        setSaid("");
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            void ask();
                        }
                    }}
                    placeholder="username"
                    aria-label="Ask by username"
                    className="max-w-xs font-mono text-xs"
                />
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !username.trim()}
                    onClick={() => void ask()}
                >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    Ask
                </Button>
            </div>
            {said && <span className="text-xs text-muted-foreground">{said}</span>}
        </div>
    );
}

"use client";

/**
 * What this account is willing to show, and who counts as a friend.
 *
 * The two are on one screen because one is the answer to the other: "friends
 * only" is meaningless until there is a list, and a list of friends that decided
 * nothing would be an address book nobody would keep.
 *
 * The reciprocity of read receipts is said in the copy rather than left to be
 * discovered, and so is the administrator exception. A privacy screen that
 * quietly does something other than what it says is worse than one that offers
 * less.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { searchPeopleAction } from "@/app/(app)/chat/actions";
import { Loader2, UserMinus, UserPlus, X } from "lucide-react";
import { Button, Card, CardBody, SegmentedControl } from "@polaris/ui";
import type { FriendRequestView, FriendView } from "@/lib/friends-service";
import { PeoplePicker, type PickedPerson } from "@/app/(app)/chat/people-picker";
import {
    removeFriendAction,
    requestFriendAction,
    respondToRequestAction,
    savePrivacyAction
} from "./actions";

export function PrivacyView({
    settings,
    friends,
    requests
}: {
    settings: core.PrivacySettings;
    friends: readonly FriendView[];
    requests: readonly FriendRequestView[];
}) {
    const [draft, setDraft] = useState(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

    const save = async () => {
        setSaving(true);
        setError("");
        await runAction(() => savePrivacyAction(draft), setError);
        setSaving(false);
    };

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-5 p-4">
                    {(["lastSeen", "readReceipts", "avatar"] as const).map((field) => (
                        <div key={field} className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">
                                {core.PRIVACY_FIELD_LABELS[field]}
                            </span>
                            <SegmentedControl
                                size="sm"
                                aria-label={core.PRIVACY_FIELD_LABELS[field]}
                                value={draft[field]}
                                onValueChange={(value) =>
                                    setDraft((current) => ({ ...current, [field]: value }))
                                }
                                options={core.PRIVACY_AUDIENCES.map((audience) => ({
                                    value: audience,
                                    label: core.PRIVACY_AUDIENCE_LABELS[audience]
                                }))}
                            />
                            <span className="text-xs text-muted-foreground">
                                {core.PRIVACY_FIELD_NOTES[field]}
                            </span>
                        </div>
                    ))}

                    <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                        Whoever administers this Polaris can see all of it whatever you choose
                        here. They can read the database, so a setting that claimed otherwise
                        would not be true.
                    </p>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}

                    <div className="flex items-center gap-3">
                        <Button onClick={() => void save()} disabled={!dirty || saving}>
                            {saving && <Loader2 className="size-4 animate-spin" />}
                            Save
                        </Button>
                        {!dirty && <span className="text-xs text-muted-foreground">Saved.</span>}
                    </div>
                </CardBody>
            </Card>

            <FriendsCard friends={friends} requests={requests} />
        </div>
    );
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
                <div>
                    <h2 className="text-sm font-medium">Friends</h2>
                    <p className="text-xs text-muted-foreground">
                        Who counts as a friend for the settings above. Being friends grants
                        nothing else - it is not a way into anything.
                    </p>
                </div>

                <PeoplePicker
                    label="Ask somebody"
                    picked={[]}
                    max={1}
                    onChange={(picked: readonly PickedPerson[]) => {
                        const person = picked.at(-1);
                        if (person) void act(() => requestFriendAction(person.id));
                    }}
                    exclude={friends.map((friend) => friend.id)}
                    search={searchPeopleAction}
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

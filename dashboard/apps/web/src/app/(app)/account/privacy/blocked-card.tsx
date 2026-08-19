"use client";

/**
 * Everybody this account has decided not to hear from.
 *
 * On the privacy screen rather than in the chat, because a block is not a chat
 * setting: it stops a friend request and a search result as well as a message,
 * and somebody whose chat has been switched off still has a list. It is also
 * the only place a block can be lifted without going and finding the person -
 * which matters, since the point of blocking somebody is not having them in
 * front of you.
 *
 * Nothing here is added from this screen. A block is set where somebody is,
 * from the menu on their name, and a picker that let one be typed in from a
 * settings page would be a way to search for people you have already said you
 * do not want to see.
 */

import { useState } from "react";
import { ShieldBan } from "lucide-react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { Avatar } from "@/components/avatar";
import { unblockPersonAction } from "./actions";
import type { BlockedPerson } from "@/lib/blocks";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

export function BlockedCard({ people }: { people: readonly BlockedPerson[] }) {
    const router = useRouter();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState("");

    const letThrough = async (person: BlockedPerson) => {
        setBusy(person.id);
        setError("");
        const result = await runAction(() => unblockPersonAction({ userId: person.id }), setError);
        setBusy("");
        if (!result?.error) router.refresh();
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Blocked</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 p-3">
                <p className="text-xs text-muted-foreground">
                    They cannot message, call or mention you, and what they write where you both are
                    is folded away. They are not told.
                </p>

                {people.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        Nobody. You can block somebody from the menu on their name.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {people.map((person) => (
                            <li
                                key={person.id}
                                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                            >
                                <Avatar person={person} size={24} />
                                <span
                                    className="min-w-0 flex-1 truncate text-sm"
                                    title={person.name}
                                >
                                    {person.name}
                                </span>
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    disabled={busy === person.id}
                                    aria-label={`Unblock ${person.name}`}
                                    title="Unblock"
                                    onClick={() => void letThrough(person)}
                                >
                                    <ShieldBan className="size-3.5" />
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

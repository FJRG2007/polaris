"use client";

/**
 * Who you are talking to, beside the conversation.
 *
 * A direct message had no right-hand panel at all: the roster is a list of
 * people and a conversation between two of them is not a list. But the column
 * was not the problem - what belongs there is the other person, which is what
 * every client with direct messages puts there, and what somebody actually
 * wants when they open one after a week away.
 *
 * What it shows is deliberately what one person may say about themselves: the
 * name they go by, the handle that tells two people with the same name apart,
 * what they wrote about themselves, and what they are showing today. Not their
 * address and not their number - those are two settings on their own privacy
 * screen, they default to nobody, and being in a conversation with somebody is
 * not consent to hand either over.
 *
 * The dot and the line under it come from the presence store, which is already
 * asking about this person for the avatar in the header. So this costs one
 * request for the profile itself, once, and nothing after that.
 */

import { AtSign, X } from "lucide-react";
import { profileAction } from "./actions";
import { useWideScreen } from "./use-wide-screen";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { PRESENCE_WORDS } from "@polaris/core";
import { usePresence } from "@/components/presence-store";
import { Dialog, DialogContent, DialogHeader, DialogTitle, Skeleton, cn } from "@polaris/ui";

/** Somebody, as this panel draws them. */
export interface DirectPerson {
    readonly id: string;
    readonly name: string;
}

interface Profile {
    readonly name: string;
    readonly username: string;
    readonly description: string;
}

function useProfile(userId: string | null): { profile: Profile | null; loading: boolean } {
    const [profile, setProfile] = useState<Profile | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!userId) {
            setProfile(null);
            return;
        }
        let live = true;
        setLoading(true);
        void profileAction(userId)
            .then((result) => {
                if (live) setProfile(result.profile ?? null);
            })
            .catch(() => undefined)
            .finally(() => {
                if (live) setLoading(false);
            });
        return () => {
            live = false;
        };
    }, [userId]);

    return { profile, loading };
}

/** The panel's contents, whichever shape it is drawn in. */
function Body({ person }: { person: DirectPerson }) {
    const { profile, loading } = useProfile(person.id);
    const where = usePresence(person.id);
    const name = profile?.name || person.name;

    return (
        <div className="flex flex-col items-center gap-3 p-4 text-center">
            <Avatar openable person={{ id: person.id, name }} size={72} status={false} />
            <div className="flex min-w-0 flex-col items-center gap-0.5">
                <p className="max-w-full truncate text-sm font-medium" title={name}>
                    {name}
                </p>
                {loading && !profile ? (
                    <Skeleton className="h-3 w-24" />
                ) : (
                    profile?.username && (
                        <p className="flex max-w-full items-center gap-0.5 truncate text-xs text-muted-foreground">
                            <AtSign className="size-3 shrink-0" />
                            {profile.username}
                        </p>
                    )
                )}
            </div>

            {/* The dot in words. A colour on its own is a convention somebody has
                to have learnt; here there is room to say it. */}
            {where && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                        aria-hidden="true"
                        className={cn(
                            "size-2 rounded-full",
                            where.status === "online" && "bg-success",
                            where.status === "idle" && "bg-warning",
                            where.status === "busy" && "bg-danger",
                            where.status === "offline" && "bg-muted-foreground/50"
                        )}
                    />
                    {PRESENCE_WORDS[where.status]}
                </p>
            )}

            {/* What they are showing today, which is only ever drawn while they
                are actually here - see `presence-service`. */}
            {where?.note && (
                <p className="w-full rounded-md bg-muted/40 px-3 py-2 text-xs text-foreground">
                    {where.note}
                </p>
            )}

            {profile?.description && (
                <div className="w-full text-left">
                    <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                        About
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {profile.description}
                    </p>
                </div>
            )}
        </div>
    );
}

/**
 * The profile, as a column beside the conversation or as a dialog over it.
 *
 * The same decision the roster makes, and made the same way: below the width
 * where both fit, a column of eighty pixels of conversation helps nobody.
 */
export function DirectProfile({
    person,
    open,
    onOpenChange
}: {
    /** The other person, or null in a conversation whose other side has deleted
     *  their account - there is nobody to draw and the panel stays shut. */
    person: DirectPerson | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    // Before the early return, which is where a hook has to be: the same
    // question the roster asks, answered by the same hook so the two panels can
    // never disagree about whether there is room for a column.
    const wide = useWideScreen();
    if (!person || !open) return null;

    if (!wide) {
        return (
            <Dialog open onOpenChange={onOpenChange}>
                <DialogContent className="max-w-xs">
                    <DialogHeader>
                        <DialogTitle>Profile</DialogTitle>
                    </DialogHeader>
                    <Body person={person} />
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <aside className="flex min-h-0 w-64 shrink-0 flex-col border-l border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <p className="text-xs font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                    Profile
                </p>
                <button
                    type="button"
                    onClick={() => onOpenChange(false)}
                    aria-label="Close the profile"
                    title="Close"
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="size-3.5" />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <Body person={person} />
            </div>
        </aside>
    );
}

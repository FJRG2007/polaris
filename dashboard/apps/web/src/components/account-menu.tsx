"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { cn } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/avatar";
import { useDisplayFormat } from "@/components/display-format";
import { usePresenceRefresh } from "@/components/presence-store";
import { Bell, Check, Link2, LogOut, UserCog } from "lucide-react";
import { noteSignOutAction } from "@/app/(app)/account/sessions/actions";
import { setPresenceAction } from "@/app/(app)/account/preferences/actions";
import {
    PRESENCE_CHOICES,
    PRESENCE_DURATIONS,
    PRESENCE_LABELS,
    type PresenceChoice
} from "@polaris/core";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger
} from "@polaris/ui";

/**
 * The personal account dropdown. Only per-user items live here; administration
 * (users, policies, domains, integrations, updates, ...) moved to the dedicated
 * Management app in the switcher, so this menu stays about "you", not the system.
 */
export function AccountMenu({
    id,
    name,
    email,
    presence,
    presenceUntil
}: {
    id: string;
    name: string;
    email: string;
    /** What this account has chosen to appear as. */
    presence: PresenceChoice;
    /** When that choice lapses, or null for "until I change it". */
    presenceUntil: string | null;
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const refreshPresence = usePresenceRefresh();
    const [open, setOpen] = useState(false);
    const [chosen, setChosen] = useState(presence);
    const [until, setUntil] = useState(presenceUntil);
    /** How the status row currently being pressed was reached, which decides
     *  whether the press is a choice or only a way into the lengths. */
    const reached = useRef("");

    /**
     * Say what to appear as, and close.
     *
     * Optimistic on both halves: the tick moves under the finger, and every dot
     * on screen is asked about again the moment the write lands rather than
     * whenever the store's next minute comes round. Waiting for that was what
     * made this look like a setting that had not taken.
     */
    const choose = async (choice: PresenceChoice, minutes: number | null) => {
        setChosen(choice);
        setUntil(
            choice === "auto" || minutes === null
                ? null
                : new Date(Date.now() + minutes * 60_000).toISOString()
        );
        setOpen(false);
        await setPresenceAction(choice, minutes);
        refreshPresence();
        // The layout resolved the choice server-side, so its own copy is stale
        // until something asks again.
        router.refresh();
    };

    async function onSignOut() {
        // While the session still exists, so the account's own history and its
        // other devices record that this one left. Never a reason to refuse the
        // sign-out itself.
        await noteSignOutAction().catch(() => undefined);
        await signOut();
        router.push("/oauth/login");
        router.refresh();
    }

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger
                aria-label="Your account"
                className="rounded-full "
            >
                <Avatar person={{ id, name }} size={32} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                    <span className="block text-sm font-medium text-foreground">{name}</span>
                    <span className="block truncate">{email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {/* Where the status lives in every application that has one: on
                    your own face, one press from anywhere. A settings page would
                    be the right place for a preference and the wrong one for
                    something people change three times a day. */}
                {PRESENCE_CHOICES.map((choice) => {
                    const face = (
                        <>
                            <span
                                aria-hidden="true"
                                className={cn("size-2 shrink-0 rounded-full", PRESENCE_DOTS[choice])}
                            />
                            <span className="flex-1">{PRESENCE_LABELS[choice]}</span>
                            {chosen === choice && until && (
                                <span className="text-[11px] text-muted-foreground">
                                    until {format.time(until)}
                                </span>
                            )}
                            {chosen === choice && <Check className="size-3.5 text-primary" />}
                        </>
                    );

                    // Online is the reset, so it has no window: "back to working
                    // it out, for an hour" is not a thing anybody means.
                    if (choice === "auto") {
                        return (
                            <DropdownMenuItem
                                key={choice}
                                onSelect={() => void choose(choice, null)}
                            >
                                {face}
                            </DropdownMenuItem>
                        );
                    }

                    // Pressing the row sets it until you change it; resting on it
                    // offers the lengths. Both, because both are habits - and the
                    // one that matters is the status somebody forgets they set.
                    //
                    // Only a mouse commits on the press. A tap and the Enter key
                    // are the only ways a finger or a keyboard has of reaching
                    // the submenu at all, so for them the press opens it - and
                    // "Until I change it" is in there, which is the same answer
                    // one press further on rather than an answer they cannot
                    // give.
                    return (
                        <DropdownMenuSub key={choice}>
                            <DropdownMenuSubTrigger
                                onKeyDown={() => {
                                    reached.current = "key";
                                }}
                                onPointerDown={(event) => {
                                    reached.current = event.pointerType;
                                }}
                                onClick={() => {
                                    const via = reached.current;
                                    reached.current = "";
                                    if (via === "mouse" || via === "pen") {
                                        void choose(choice, null);
                                    }
                                }}
                            >
                                {face}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {PRESENCE_DURATIONS.map((duration) => (
                                    <DropdownMenuItem
                                        key={duration.label}
                                        onSelect={() => void choose(choice, duration.minutes)}
                                    >
                                        {duration.label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href="/account">
                        <UserCog className="size-4" />
                        My account
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <Link href="/account/notifications">
                        <Bell className="size-4" />
                        Notifications
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <Link href="/drive/shared-links">
                        <Link2 className="size-4" />
                        Shared links
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onSignOut}>
                    <LogOut className="size-4" />
                    Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The colour beside each choice, so the menu says what the dot will look like
 *  rather than only what it is called. */
const PRESENCE_DOTS: Record<PresenceChoice, string> = {
    auto: "bg-success",
    busy: "bg-danger",
    away: "bg-warning",
    invisible: "bg-border-strong"
};

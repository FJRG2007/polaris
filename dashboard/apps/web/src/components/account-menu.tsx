"use client";

import Link from "next/link";
import { cn } from "@polaris/ui";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/avatar";
import { useDisplayFormat } from "@/components/display-format";
import { usePresenceRefresh } from "@/components/presence-store";
import { Bell, Check, Link2, LogOut, MessageSquareText, UserCog } from "lucide-react";
import { noteSignOutAction } from "@/app/(app)/account/sessions/actions";
import { setPresenceAction, setStatusAction } from "@/app/(app)/account/preferences/actions";
import {
    MAX_STATUS,
    PRESENCE_CHOICES,
    PRESENCE_DURATIONS,
    PRESENCE_LABELS,
    STATUS_DURATIONS,
    type PresenceChoice
} from "@polaris/core";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Input,
    Select
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
    presenceUntil,
    status,
    statusUntil
}: {
    id: string;
    name: string;
    email: string;
    /** What this account has chosen to appear as. */
    presence: PresenceChoice;
    /** When that choice lapses, or null for "until I change it". */
    presenceUntil: string | null;
    /** The line this account is showing, empty for none. Already resolved, so a
     *  lapsed one arrives as empty rather than as something to un-set. */
    status: string;
    /** When that line clears, or null for "until I clear it". */
    statusUntil: string | null;
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
    /** Whether the status dialog is up, and what is in it. Held here rather than
     *  inside the dialog so the menu can close on the way in - a dialog mounted
     *  inside a menu is unmounted by the item that opens it. */
    const [writing, setWriting] = useState(false);
    const [line, setLine] = useState(status);
    const [clears, setClears] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);

    /** Store the line, or take it off. An empty one is the same request as
     *  pressing Clear, which is why there is only one path out of here. */
    const saveStatus = async (text: string, minutes: number | null) => {
        setSaving(true);
        setLine(text);
        await setStatusAction({ text, minutes });
        setSaving(false);
        setWriting(false);
        refreshPresence();
        router.refresh();
    };

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
        <>
        {/* Not modal, which is what makes the double press below possible: a
            modal menu takes the pointer away from everything behind it, its own
            trigger included, so the second press of a double never reaches the
            face it was aimed at. */}
        <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
            <DropdownMenuTrigger
                aria-label="Your account"
                title="Your account. Press twice to open it."
                // Straight there. Your own face is the way to your own account
                // in every application that has one, and going through a menu to
                // press the item named after the thing you just pressed is a step
                // that exists for no reason. The menu opens and closes under the
                // two presses, which is what every double-click on a menu does.
                onDoubleClick={() => {
                    setOpen(false);
                    router.push("/account");
                }}
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
                {/* Under the four dots and above everything else, because it is
                    the same question one answer further on: the dot says whether
                    to expect a reply and this says why. */}
                <DropdownMenuItem
                    onSelect={() => {
                        setLine(status);
                        // Reopened on what is already set: a status standing
                        // until it is cleared should not offer to start
                        // expiring because the dialog was opened again.
                        setClears(statusUntil ? nearestWindow(statusUntil) : null);
                        setWriting(true);
                    }}
                >
                    <MessageSquareText className="size-4" />
                    <span className="min-w-0 truncate">{status || "Set a status"}</span>
                </DropdownMenuItem>
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

        {/* Outside the menu, which closes on the item that opens this: a dialog
            mounted inside one is unmounted the moment it is asked for. */}
        <Dialog open={writing} onOpenChange={setWriting}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Set a status</DialogTitle>
                    <DialogDescription>
                        Shown beside your name while you are online.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Input
                        autoFocus
                        value={line}
                        maxLength={MAX_STATUS}
                        placeholder="What are you up to?"
                        onChange={(event) => setLine(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void saveStatus(line, clears);
                        }}
                    />
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">Clear</span>
                        <Select
                            value={String(clears)}
                            aria-label="When the status clears"
                            options={STATUS_DURATIONS.map((duration) => ({
                                value: String(duration.minutes),
                                label: duration.label
                            }))}
                            onValueChange={(value) =>
                                setClears(value === "null" ? null : Number(value))
                            }
                        />
                    </label>
                </div>
                <DialogFooter>
                    {/* Only where there is one to take off. A Clear that clears
                        nothing is a button that does nothing. */}
                    {status && (
                        <Button
                            variant="ghost"
                            disabled={saving}
                            onClick={() => void saveStatus("", null)}
                        >
                            Clear it
                        </Button>
                    )}
                    <Button disabled={saving} onClick={() => void saveStatus(line, clears)}>
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
        </>
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

/**
 * Which of the offered windows a stored moment is closest to.
 *
 * The moment is stored, not the window that produced it, so reopening the dialog
 * has to work backwards. Closest rather than exact, because time has passed
 * since it was set - and the alternative, showing "Don't clear" over a status
 * that plainly does, would be the dialog contradicting itself.
 */
function nearestWindow(until: string): number | null {
    const left = (new Date(until).getTime() - Date.now()) / 60_000;
    if (left <= 0) return null;
    let closest: number | null = null;
    let best = Infinity;
    for (const duration of STATUS_DURATIONS) {
        if (duration.minutes === null) continue;
        const distance = Math.abs(duration.minutes - left);
        if (distance < best) {
            best = distance;
            closest = duration.minutes;
        }
    }
    return closest;
}

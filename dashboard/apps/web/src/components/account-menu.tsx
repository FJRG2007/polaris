"use client";

import Link from "next/link";
import { cn } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/avatar";
import { useDisplayFormat } from "@/components/display-format";
import { usePresenceRefresh } from "@/components/presence-store";
import { PRESENCE_CHOICE_DOTS } from "@/components/presence-dots";
import {
    Bell,
    CalendarClock,
    Check,
    Link2,
    LogOut,
    MessageSquareText,
    UserCog
} from "lucide-react";
import { noteSignOutAction } from "@/app/(app)/account/sessions/actions";
import { setPresenceAction, setStatusAction } from "@/app/(app)/account/preferences/actions";
import {
    MAX_STATUS,
    PRESENCE_CHOICES,
    PRESENCE_DURATIONS,
    PRESENCE_LABELS,
    STATUS_DURATIONS,
    MAX_WINDOW_MS,
    windowEndsAt,
    type DisplayFormat,
    type PresenceChoice,
    type WindowChoice
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
    presenceScheduled,
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
    /** Whether a status schedule is holding it rather than something they
     *  pressed. Said beside the tick, because a state nobody remembers choosing
     *  is the one people hunt for the setting behind. */
    presenceScheduled: boolean;
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
    const [byRule, setByRule] = useState(presenceScheduled);
    /** The choice whose exact end is being picked, or null when that dialog is
     *  shut. Held here for the reason the status dialog is: a dialog mounted
     *  inside a menu is unmounted by the item that opens it. */
    const [timing, setTiming] = useState<PresenceChoice | null>(null);
    const [moment, setMoment] = useState("");
    /** How the status row currently being pressed was reached, which decides
     *  whether the press is a choice or only a way into the lengths. */
    const reached = useRef("");
    /** Whether the status dialog is up, and what is in it. Held here rather than
     *  inside the dialog so the menu can close on the way in - a dialog mounted
     *  inside a menu is unmounted by the item that opens it. */
    const [writing, setWriting] = useState(false);
    const [line, setLine] = useState(status);
    const [clears, setClears] = useState<number | null>(null);
    /**
     * An exact moment for the status to clear at, or null when one of the
     * offered lengths is in use instead.
     *
     * Null rather than an empty string, and the difference is a field that works
     * against one that vanishes: a date input hands back "" the moment somebody
     * clears it to retype, and a mode inferred from "is this filled in" would
     * take the field away under them halfway through the edit.
     */
    const [clearsAt, setClearsAt] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // All three are resolved in the layout, so a window that lapses or a
    // schedule that opens arrives here as new props. Without this the menu would
    // go on showing whatever was true when the tab was opened, which is exactly
    // the case a schedule creates: nobody reloads at midnight.
    useEffect(() => {
        setChosen(presence);
        setUntil(presenceUntil);
        setByRule(presenceScheduled);
    }, [presence, presenceUntil, presenceScheduled]);

    /** What is wrong with the moment being typed, empty when nothing is - and
     *  the one answer the two fields add up to, which is only ever built from a
     *  moment that is a moment. */
    const badMoment = clearsAt === null ? "" : momentProblem(clearsAt);
    const badTiming = timing === null ? "" : momentProblem(moment);
    const statusWindow: WindowChoice =
        clearsAt !== null && !badMoment
            ? { until: new Date(clearsAt).toISOString() }
            : { minutes: clears };

    /** Store the line, or take it off. An empty one is the same request as
     *  pressing Clear, which is why there is only one path out of here. */
    const saveStatus = async (text: string, window: WindowChoice) => {
        setSaving(true);
        setLine(text);
        await setStatusAction({ text, ...window });
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
    const choose = async (choice: PresenceChoice, window: WindowChoice = {}) => {
        const ends = choice === "auto" ? null : windowEnd(window);
        setChosen(choice);
        setUntil(ends);
        // Whatever a schedule was doing, this is not it any more: a choice made
        // inside an open window is the account overruling its own rule until
        // that window closes.
        setByRule(false);
        setOpen(false);
        setTiming(null);
        await setPresenceAction(choice, window);
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
                                className={cn(
                                    "size-2 shrink-0 rounded-full",
                                    PRESENCE_CHOICE_DOTS[choice]
                                )}
                            />
                            <span className="flex-1">{PRESENCE_LABELS[choice]}</span>
                            {chosen === choice && until && (
                                <span className="text-[11px] text-muted-foreground">
                                    {byRule ? "scheduled, until " : "until "}
                                    {endLabel(until, format)}
                                </span>
                            )}
                            {chosen === choice && <Check className="size-3.5 text-primary" />}
                        </>
                    );

                    // Online is the reset, so it has no window: "back to working
                    // it out, for an hour" is not a thing anybody means.
                    if (choice === "auto") {
                        return (
                            <DropdownMenuItem key={choice} onSelect={() => void choose(choice)}>
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
                                        void choose(choice);
                                    }
                                }}
                            >
                                {face}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {PRESENCE_DURATIONS.map((duration) => (
                                    <DropdownMenuItem
                                        key={duration.label}
                                        onSelect={() => void choose(choice, { minutes: duration.minutes })}
                                    >
                                        {duration.label}
                                    </DropdownMenuItem>
                                ))}
                                <DropdownMenuSeparator />
                                {/* The two answers a ladder of lengths cannot
                                    give: a moment somebody has in mind, and a
                                    part of the week they already know about. */}
                                <DropdownMenuItem
                                    onSelect={() => {
                                        setOpen(false);
                                        setMoment(localInput(new Date(Date.now() + 60 * 60_000)));
                                        setTiming(choice);
                                    }}
                                >
                                    Until a date and time...
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild>
                                    <Link href="/account/privacy/schedule">
                                        <CalendarClock className="size-4" />
                                        Every week...
                                    </Link>
                                </DropdownMenuItem>
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
                        // expiring because the dialog was opened again, and one
                        // that does expire says the moment it was actually set
                        // to rather than the offered length nearest to it.
                        setClears(null);
                        setClearsAt(statusUntil ? localInput(new Date(statusUntil)) : null);
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

        {/* The exact end of a chosen state. Its own dialog rather than a field
            in the menu, because a menu that has to stay open while somebody
            picks a date is a menu that shuts on the first press outside it. */}
        <Dialog open={timing !== null} onOpenChange={(next) => !next && setTiming(null)}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>
                        {timing ? PRESENCE_LABELS[timing] : ""} until a date and time
                    </DialogTitle>
                    <DialogDescription>
                        You go back to being shown as online after this.
                    </DialogDescription>
                </DialogHeader>
                <Input
                    autoFocus
                    type="datetime-local"
                    value={moment}
                    min={localInput(new Date())}
                    aria-label="When it goes back to normal"
                    onChange={(event) => setMoment(event.target.value)}
                />
                {badTiming ? <p className="text-xs text-danger">{badTiming}</p> : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={() => setTiming(null)}>
                        Cancel
                    </Button>
                    <Button
                        aria-disabled={Boolean(badTiming)}
                        onClick={() => {
                            if (!timing || badTiming) return;
                            void choose(timing, { until: new Date(moment).toISOString() });
                        }}
                    >
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

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
                            if (event.key === "Enter" && !badMoment) {
                                void saveStatus(line, statusWindow);
                            }
                        }}
                    />
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">Clear</span>
                        <Select
                            value={clearsAt === null ? String(clears) : AT_A_TIME}
                            aria-label="When the status clears"
                            options={[
                                ...STATUS_DURATIONS.map((duration) => ({
                                    value: String(duration.minutes),
                                    label: duration.label
                                })),
                                { value: AT_A_TIME, label: "At a date and time..." }
                            ]}
                            onValueChange={(value) => {
                                if (value === AT_A_TIME) {
                                    return setClearsAt(
                                        clearsAt || localInput(new Date(Date.now() + 60 * 60_000))
                                    );
                                }
                                setClearsAt(null);
                                setClears(value === "null" ? null : Number(value));
                            }}
                        />
                    </label>
                    {clearsAt !== null ? (
                        <Input
                            type="datetime-local"
                            value={clearsAt}
                            min={localInput(new Date())}
                            aria-label="The date and time the status clears"
                            onChange={(event) => setClearsAt(event.target.value)}
                        />
                    ) : null}
                    {badMoment ? (
                        <p className="text-xs text-danger">{badMoment}</p>
                    ) : null}
                </div>
                <DialogFooter>
                    {/* Only where there is one to take off. A Clear that clears
                        nothing is a button that does nothing. */}
                    {status && (
                        <Button
                            variant="ghost"
                            disabled={saving}
                            onClick={() => void saveStatus("", {})}
                        >
                            Clear it
                        </Button>
                    )}
                    <Button
                        disabled={saving}
                        aria-disabled={Boolean(badMoment)}
                        onClick={() => !badMoment && void saveStatus(line, statusWindow)}
                    >
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
        </>
    );
}

/** The value the "at a time" select carries. Not a number, so it can never
 *  collide with one of the offered lengths. */
const AT_A_TIME = "at";

/**
 * A moment as a `datetime-local` input reads and writes it.
 *
 * Built from the parts rather than through a formatter on purpose: that input
 * has one format and it is the device's own clock, so anything else - the
 * account's chosen timezone included - would put a reading in the field that the
 * browser then reads back as a different instant.
 */
function localInput(at: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** What is wrong with a picked moment, empty when nothing is. The same two
 *  limits the server checks, said before the trip rather than after it. */
function momentProblem(value: string): string {
    if (!value) return "Pick a date and time.";
    const at = new Date(value).getTime();
    if (!Number.isFinite(at)) return "That is not a date and time.";
    if (at <= Date.now()) return "Pick a moment that has not passed.";
    if (at - Date.now() > MAX_WINDOW_MS) return "Pick a moment inside the next year.";
    return "";
}

/** The moment a window lands on, for the optimistic half of a choice. */
function windowEnd(window: WindowChoice): string | null {
    return windowEndsAt(window)?.toISOString() ?? null;
}

/**
 * When a window ends, as the row above it says so.
 *
 * The time alone for something ending today, which is almost all of them and the
 * shortest thing that can be said. The date as well once it is not - "until
 * 09:00" under a state that holds until Monday is the menu misreporting the one
 * fact somebody opened it to check.
 */
function endLabel(until: string, format: DisplayFormat): string {
    const at = new Date(until);
    // Compared through the account's own formatters rather than the device's:
    // "today" is a question about the clock these are all read on.
    return format.date(at) === format.date(new Date()) ? format.time(at) : format.dateTime(at);
}

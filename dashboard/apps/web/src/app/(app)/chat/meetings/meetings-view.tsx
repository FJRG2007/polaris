"use client";

/**
 * The meetings this account is hosting or has been asked to.
 *
 * A meeting is the one thing in Chat that is not a conversation: it has a name,
 * usually a time, and a link that anybody at all can open. So it needs a list,
 * because the thing somebody does with a meeting the day before it happens is
 * find it again - and the thing they do a minute before is press one button.
 *
 * Running ones come first and say so. After that it is the diary, soonest first,
 * and then the rooms with no time on them at all, which are the ones somebody
 * opened to use straight away.
 */

import Link from "next/link";
import { copyText } from "@/app/(app)/chat/links";
import { useChat } from "@/app/(app)/chat/chat-context";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useAppUrl } from "@/components/app-url";
import { useCallback, useEffect, useState } from "react";
import type { MeetingSummary } from "@/lib/chat/meetings";
import { MAX_MEETING_TITLE } from "@/lib/chat/meeting-limits";
import { useDisplayFormat } from "@/components/display-format";
import { Calendar, Link2, Loader2, Plus, Users, Video } from "lucide-react";
import { createMeetingAction, listMeetingsAction } from "@/app/(app)/chat/meeting-actions";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Skeleton,
    Switch,
    cn
} from "@polaris/ui";

export function MeetingsView() {
    const router = useRouter();
    const baseUrl = useAppUrl();
    const format = useDisplayFormat();
    const { may } = useChat();
    const [meetings, setMeetings] = useState<readonly MeetingSummary[] | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState("");
    const [copied, setCopied] = useState("");

    const load = useCallback(async () => {
        const result = await listMeetingsAction();
        setMeetings(result.meetings);
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
                <Video className="size-4 shrink-0 text-muted-foreground" />
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Meetings</h1>
                {may.meetings && (
                    <Button size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-4" />
                        New meeting
                    </Button>
                )}
            </header>

            <div className="flex flex-col gap-3 p-4">
                <p className="text-xs text-muted-foreground">
                    A room with a link anybody can open, whether or not they have a Polaris
                    account. Whoever creates one hosts it.
                </p>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                {meetings === null ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-16 w-full" />
                        <Skeleton className="h-16 w-full" />
                    </div>
                ) : meetings.length === 0 ? (
                    <EmptyState
                        icon={<Calendar />}
                        title="No meetings"
                        description={
                            may.meetings
                                ? "Create one to get a link you can send to anybody."
                                : "You will see meetings here when somebody invites you to one."
                        }
                    />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {meetings.map((meeting) => (
                            <li key={meeting.id}>
                                <Card>
                                    <CardBody className="flex flex-wrap items-center gap-x-4 gap-y-2">
                                        <span className="min-w-0 flex-1">
                                            <Link
                                                href={`/chat/meetings/${meeting.id}`}
                                                className="block truncate text-sm font-medium no-underline hover:underline"
                                            >
                                                {meeting.title}
                                            </Link>
                                            <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                                <span>
                                                    {meeting.mine
                                                        ? "You are hosting"
                                                        : `${meeting.hostName} is hosting`}
                                                </span>
                                                <span>{whenIs(meeting, format.dateTime)}</span>
                                                {meeting.present > 0 && (
                                                    <span className="flex items-center gap-1 text-success">
                                                        <Users className="size-3.5 shrink-0" />
                                                        {meeting.present === 1
                                                            ? "1 person is in it"
                                                            : `${meeting.present} people are in it`}
                                                    </span>
                                                )}
                                                {meeting.requireAccount && (
                                                    <span>Polaris accounts only</span>
                                                )}
                                            </span>
                                        </span>

                                        {meeting.guestToken && (
                                            <Button
                                                size="xs"
                                                variant="secondary"
                                                title="Copy the link to send"
                                                onClick={async () => {
                                                    await copyText(
                                                        `${baseUrl}/m/${meeting.guestToken}`
                                                    );
                                                    setCopied(meeting.id);
                                                    window.setTimeout(() => setCopied(""), 2000);
                                                }}
                                            >
                                                <Link2 className="size-3.5" />
                                                {copied === meeting.id ? "Copied" : "Copy link"}
                                            </Button>
                                        )}
                                        <Button
                                            size="xs"
                                            onClick={() =>
                                                router.push(`/chat/meetings/${meeting.id}?join=1`)
                                            }
                                        >
                                            <Video className="size-3.5" />
                                            Join
                                        </Button>
                                    </CardBody>
                                </Card>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <NewMeetingDialog
                open={creating}
                onClose={() => setCreating(false)}
                onCreated={(meetingId) => {
                    setCreating(false);
                    router.push(`/chat/meetings/${meetingId}`);
                }}
                onError={setError}
            />
        </div>
    );
}

/** When a meeting is, in the fewest words that are still true. */
function whenIs(meeting: MeetingSummary, dateTime: (iso: string) => string): string {
    if (meeting.present > 0) return "Happening now";
    if (!meeting.scheduledAt) return "Open whenever you are";
    const at = new Date(meeting.scheduledAt);
    return at.getTime() < Date.now()
        ? `Was due ${dateTime(meeting.scheduledAt)}`
        : dateTime(meeting.scheduledAt);
}

function NewMeetingDialog({
    open,
    onClose,
    onCreated,
    onError
}: {
    open: boolean;
    onClose: () => void;
    onCreated: (meetingId: string) => void;
    onError: (message: string) => void;
}) {
    const [title, setTitle] = useState("");
    const [when, setWhen] = useState("");
    const [approveGuests, setApproveGuests] = useState(true);
    const [requireAccount, setRequireAccount] = useState(false);
    const [busy, setBusy] = useState(false);

    // Emptied on the way in rather than on the way out, so a dialog reopened
    // after a mistake is not still holding the mistake.
    useEffect(() => {
        if (!open) return;
        setTitle("");
        setWhen("");
        setApproveGuests(true);
        setRequireAccount(false);
    }, [open]);

    const create = async () => {
        setBusy(true);
        const result = await runAction(
            () =>
                createMeetingAction({
                    title,
                    // The field is a local time and the server is nowhere, so it
                    // is turned into a moment here, where the reader's clock is.
                    scheduledAt: when ? new Date(when).toISOString() : null,
                    approveGuests,
                    requireAccount
                }),
            onError
        );
        setBusy(false);
        if (result?.meetingId) onCreated(result.meetingId);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New meeting</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">
                            Name<span className="text-danger"> *</span>
                        </span>
                        <Input
                            autoFocus
                            value={title}
                            maxLength={MAX_MEETING_TITLE}
                            placeholder="What it is about"
                            onChange={(event) => setTitle(event.target.value)}
                        />
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">When</span>
                        <Input
                            type="datetime-local"
                            value={when}
                            onChange={(event) => setWhen(event.target.value)}
                        />
                        <span className="text-[11px] text-muted-foreground">
                            Leave it empty for a room that is open as soon as you make it.
                        </span>
                    </label>

                    <Setting
                        label="Let people in yourself"
                        hint="Anybody on the link waits until you admit them. A link that can be forwarded will be."
                        checked={approveGuests}
                        onChange={setApproveGuests}
                    />
                    <Setting
                        label="Polaris accounts only"
                        hint="The link names the meeting but only opens for somebody signed in."
                        checked={requireAccount}
                        onChange={setRequireAccount}
                    />
                </div>
                <DialogFooter>
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button size="sm" disabled={busy || !title.trim()} onClick={() => void create()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Create
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Setting({
    label,
    hint,
    checked,
    onChange,
    className
}: {
    label: string;
    hint: string;
    checked: boolean;
    onChange: (next: boolean) => void;
    className?: string;
}) {
    return (
        <label className={cn("flex items-start justify-between gap-4", className)}>
            <span className="min-w-0">
                <span className="block text-xs font-medium">{label}</span>
                <span className="block text-[11px] text-muted-foreground">{hint}</span>
            </span>
            <Switch checked={checked} onChange={onChange} aria-label={label} />
        </label>
    );
}

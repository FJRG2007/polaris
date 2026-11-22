"use client";

/**
 * The meetings this account is hosting or has been asked to.
 *
 * A meeting is the one thing in Chat that is not a conversation: it has a name,
 * usually a time, and a link that anybody at all can open. So it needs a list,
 * because the thing somebody does with a meeting the day before it happens is
 * find it again - and the thing they do a minute before is press one button.
 *
 * It is a table like every other list in Polaris: searched and filtered in the
 * database, sorted by its headings, and each row's actions reached from the
 * three dots or a right-click. Closing a meeting is named by what it is right
 * now - ended, cancelled or deleted - and only the host is offered it, the same
 * check the server makes before it closes anything.
 */

import Link from "next/link";
import * as polls from "../chat-reads";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useAppUrl } from "@/components/app-url";
import { copyText } from "@/app/(app)/chat/links";
import { useRemovalWords } from "./meeting-removal";
import { useChat } from "@/app/(app)/chat/chat-context";
import { useConfirm } from "@/components/confirm-dialog";
import { MOST_EMAILS } from "@/lib/chat/meeting-invites";
import type { MeetingSummary } from "@/lib/chat/meetings";
import { CallRoster } from "@/app/(app)/chat/call-roster";
import { MAX_MEETING_TITLE } from "@/lib/chat/meeting-limits";
import { searchPeopleAction } from "@/app/(app)/chat/actions";
import { useDisplayFormat } from "@/components/display-format";
import { MeetingDetailsDialog } from "./meeting-details-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDebounced } from "@/app/(app)/telemetry/use-debounced";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { RowActionsMenu, RowContextMenu, type RowAction } from "@/components/row-menu";
import { EmailInvitesField, useInvitationText, withDraft } from "./meeting-invitation";
import {
    MAX_MEETING_SEARCH,
    meetingState,
    removalFor,
    restoreRow,
    withoutRow,
    type MeetingScope,
    type MeetingSort,
    type MeetingState,
    type MeetingWhen
} from "@/lib/chat/meeting-list";
import {
    ArrowLeft,
    Calendar,
    ClipboardCopy,
    ExternalLink,
    Link2,
    Loader2,
    Pencil,
    Plus,
    Trash2,
    Video
} from "lucide-react";
import {
    createMeetingAction,
    endMeetingAction
} from "@/app/(app)/chat/meeting-actions";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    SearchField,
    SegmentedControl,
    Skeleton,
    SortHeader,
    Switch,
    cn,
    DateInput,
    nextSort,
    useToast,
    type TableSortDirection
} from "@polaris/ui";

/** The last answer for each query, so going back to one paints it at once. */
const lastAnswers = new Map<string, readonly MeetingSummary[]>();

/** How long the search waits for the typing to stop before it asks. */
const SEARCH_DEBOUNCE_MS = 250;

const COLUMNS = 5;

export function MeetingsView() {
    const t = useTranslations("chat");
    const router = useRouter();
    const baseUrl = useAppUrl();
    const format = useDisplayFormat();
    const toast = useToast();
    const invitationText = useInvitationText();
    const removalWords = useRemovalWords();
    const [confirm, confirmElement] = useConfirm();
    const { may } = useChat();

    const [search, setSearch] = useState("");
    const [when, setWhen] = useState<MeetingWhen>("upcoming");
    const [scope, setScope] = useState<MeetingScope>("all");
    const [sort, setSort] = useState<{ order: MeetingSort; direction: TableSortDirection }>({
        order: "when",
        direction: "asc"
    });
    const q = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
    const query: Record<string, string> = {
        when,
        scope,
        sort: sort.order,
        dir: sort.direction,
        ...(q ? { q } : {})
    };
    const key = JSON.stringify(query);

    const [meetings, setMeetings] = useState<readonly MeetingSummary[] | null>(
        () => lastAnswers.get(key) ?? null
    );
    const [loadFailed, setLoadFailed] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState("");
    /** The meeting whose name and hour are being changed, if any. */
    const [editing, setEditing] = useState<MeetingSummary | null>(null);
    const latest = useRef(key);

    const load = useCallback(async (signal?: AbortSignal) => {
        const asked = key;
        try {
            const result = await polls.meetingList(signal, JSON.parse(asked) as Record<string, string>);
            lastAnswers.set(asked, result.meetings);
            if (latest.current !== asked) return;
            setMeetings(result.meetings);
            setLoadFailed(false);
        } catch {
            if (signal?.aborted || latest.current !== asked) return;
            setLoadFailed(true);
        }
    }, [key]);

    useEffect(() => {
        latest.current = key;
        // What this query answered last time is drawn at once; the request only
        // replaces it if something changed. A query never asked shows skeletons.
        setMeetings(lastAnswers.get(key) ?? null);
        setLoadFailed(false);
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [key, load]);

    useEffect(() => {
        const again = () => {
            if (document.visibilityState === "visible") void load();
        };
        document.addEventListener("visibilitychange", again);
        return () => document.removeEventListener("visibilitychange", again);
    }, [load]);

    const reload = useCallback(() => {
        lastAnswers.clear();
        void load();
    }, [load]);

    const remove = async (meeting: MeetingSummary) => {
        const words = removalWords(removalFor(meetingState(meeting)), meeting.title);
        const sure = await confirm({
            title: words.title,
            description: words.body,
            confirmLabel: words.action,
            danger: true
        });
        if (!sure) return;
        setError("");
        let index = -1;
        setMeetings((rows) => {
            if (!rows) return rows;
            const next = withoutRow(rows, meeting.id);
            index = next.index;
            return next.rows;
        });
        const result = await runAction(() => endMeetingAction(meeting.id), setError);
        if (result === null || result.error) {
            if (result?.error) setError(result.error);
            setMeetings((rows) => (rows ? restoreRow(rows, meeting, index) : rows));
            return;
        }
        lastAnswers.clear();
    };

    const copyLink = async (meeting: MeetingSummary) => {
        await copyText(`${baseUrl}/m/${meeting.guestToken}`);
        toast.show({ key: "meeting-copy", title: t("meetings.linkCopied") });
    };

    const copyInvitation = async (meeting: MeetingSummary) => {
        await copyText(invitationText(meeting));
        toast.show({ key: "meeting-copy", title: t("meetings.invitationCopied") });
    };

    const join = (meeting: MeetingSummary) => router.push(`/chat/meetings/${meeting.id}?join=1`);

    const joinLabel = (meeting: MeetingSummary, state: MeetingState) =>
        state !== "live" && meeting.mine ? t("meetings.start") : t("meetings.join");

    const actionsFor = (meeting: MeetingSummary, state: MeetingState): RowAction[] => {
        const actions: RowAction[] = [
            {
                key: "join",
                label: joinLabel(meeting, state),
                icon: <Video className="size-4 shrink-0" />,
                onSelect: () => join(meeting)
            },
            {
                key: "open",
                label: t("meetings.open"),
                icon: <ExternalLink className="size-4 shrink-0" />,
                href: `/chat/meetings/${meeting.id}`
            }
        ];
        if (meeting.guestToken) {
            actions.push({
                key: "copy-link",
                label: t("meetings.copyLink"),
                icon: <Link2 className="size-4 shrink-0" />,
                onSelect: () => void copyLink(meeting)
            });
        }
        if (meeting.mine && (meeting.guestToken || meeting.joinCode)) {
            actions.push({
                key: "copy-invitation",
                label: t("meetingInvites.copyInvitation"),
                icon: <ClipboardCopy className="size-4 shrink-0" />,
                onSelect: () => void copyInvitation(meeting)
            });
        }
        if (meeting.mine) {
            actions.push(
                {
                    key: "edit",
                    label: t("meetings.renameOrReschedule"),
                    icon: <Pencil className="size-4 shrink-0" />,
                    onSelect: () => setEditing(meeting),
                    manage: true
                },
                {
                    key: "remove",
                    label: removalWords(removalFor(state), meeting.title).action,
                    icon: <Trash2 className="size-4 shrink-0" />,
                    onSelect: () => void remove(meeting),
                    danger: true,
                    manage: true
                }
            );
        }
        return actions;
    };

    const stateBadge = (state: MeetingState) => {
        if (state === "live") return <Badge variant="success">{t("meetings.stateLive")}</Badge>;
        if (state === "upcoming") return <Badge variant="primary">{t("meetings.stateUpcoming")}</Badge>;
        if (state === "open") return <Badge>{t("meetings.stateOpen")}</Badge>;
        return <Badge variant="warning">{t("meetings.statePast")}</Badge>;
    };

    const whenText = (meeting: MeetingSummary) => {
        if (!meeting.scheduledAt) return t("meetings.noSetTime");
        return new Date(meeting.scheduledAt).getTime() < Date.now()
            ? t("meetings.wasDue", { when: format.dateTime(meeting.scheduledAt) })
            : format.dateTime(meeting.scheduledAt);
    };

    const hostText = (meeting: MeetingSummary) =>
        meeting.mine ? t("meetings.youAreHosting") : meeting.hostName;

    const filtered = Boolean(q) || scope === "mine";
    const empty = filtered
        ? { title: t("meetings.nothingMatches"), description: t("meetings.tryAnotherSearch") }
        : when === "past"
          ? { title: t("meetings.noPastMeetings"), description: t("meetings.pastMeetingsLandHere") }
          : {
                title: when === "upcoming" ? t("meetings.nothingComingUp") : t("meetings.noMeetings"),
                description: may.meetings
                    ? t("meetings.createOneToGetA")
                    : t("meetings.youWillSeeMeetingsHere")
            };

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
                {/* On a phone this page has the whole screen, so it carries the
                    way back to the list, as a conversation's header does. */}
                <Link data-swipe-back
                    href="/chat"
                    aria-label={t("channelHeader.backToConversations")}
                    className="-ms-1.5 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <Video className="size-4 shrink-0 text-muted-foreground" />
                <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
                    {t("meetings.meetings")}
                </h1>
                {may.meetings && (
                    <Button
                        size="sm"
                        onClick={() => setCreating(true)}
                        title={t("meetings.newMeeting")}
                        aria-label={t("meetings.newMeeting")}
                    >
                        <Plus className="size-4 shrink-0" />
                        <span className="hidden sm:inline">{t("meetings.newMeeting")}</span>
                    </Button>
                )}
            </header>

            <div className="flex min-w-0 flex-col gap-3 p-4">
                <p className="text-xs text-muted-foreground">{t("meetings.aRoomWithALink")}</p>

                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <SearchField
                        wrapperClassName="w-full sm:w-64"
                        value={search}
                        maxLength={MAX_MEETING_SEARCH}
                        placeholder={t("meetings.searchMeetings")}
                        aria-label={t("meetings.searchMeetings")}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                    <SegmentedControl
                        size="sm"
                        aria-label={t("meetings.whenFilter")}
                        value={when}
                        onValueChange={(next) => {
                            setWhen(next);
                            // The past reads newest first, the diary soonest first.
                            setSort((current) =>
                                current.order === "when"
                                    ? { order: "when", direction: next === "past" ? "desc" : "asc" }
                                    : current
                            );
                        }}
                        options={[
                            { value: "upcoming", label: t("meetings.whenUpcoming") },
                            { value: "past", label: t("meetings.whenPast") },
                            { value: "all", label: t("meetings.whenAll") }
                        ]}
                    />
                    <SegmentedControl
                        size="sm"
                        aria-label={t("meetings.scopeFilter")}
                        value={scope}
                        onValueChange={setScope}
                        options={[
                            { value: "all", label: t("meetings.scopeAll") },
                            { value: "mine", label: t("meetings.scopeMine") }
                        ]}
                    />
                </div>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-sm">
                        <thead className="bg-surface/60 text-start text-xs text-muted-foreground">
                            <tr>
                                <SortHeader
                                    label={t("meetings.name")}
                                    order="title"
                                    sort={sort}
                                    onSort={(order) => setSort((current) => nextSort(current, order))}
                                    className="w-full max-w-0"
                                />
                                <SortHeader
                                    label={t("meetings.when")}
                                    order="when"
                                    sort={sort}
                                    onSort={(order) => setSort((current) => nextSort(current, order))}
                                    className="hidden lg:table-cell"
                                />
                                <th scope="col" className="hidden px-3 py-2 font-medium xl:table-cell">
                                    {t("meetings.colHost")}
                                </th>
                                <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">
                                    {t("meetings.colStatus")}
                                </th>
                                <th scope="col" className="px-3 py-2">
                                    <span className="sr-only">{t("meetings.colActions")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {meetings === null && loadFailed ? (
                                <tr className="border-t border-border">
                                    <td colSpan={COLUMNS} className="px-3 py-6">
                                        <div className="flex flex-col items-center gap-2 text-center">
                                            <p role="alert" className="text-sm text-danger">
                                                {t("meetings.couldNotLoad")}
                                            </p>
                                            <Button size="sm" variant="secondary" onClick={reload}>
                                                {t("meetings.tryAgain")}
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ) : meetings === null ? (
                                [0, 1, 2].map((row) => (
                                    <tr key={row} className="border-t border-border">
                                        <td className="px-3 py-2" colSpan={COLUMNS}>
                                            <Skeleton className="h-9 w-full" />
                                        </td>
                                    </tr>
                                ))
                            ) : meetings.length === 0 ? (
                                <tr className="border-t border-border">
                                    <td colSpan={COLUMNS} className="px-3 py-2">
                                        <EmptyState
                                            icon={<Calendar />}
                                            title={empty.title}
                                            description={empty.description}
                                        />
                                    </td>
                                </tr>
                            ) : (
                                meetings.map((meeting) => {
                                    const state = meetingState(meeting);
                                    const actions = actionsFor(meeting, state);
                                    return (
                                        <RowContextMenu
                                            key={meeting.id}
                                            title={meeting.title}
                                            actions={actions}
                                        >
                                            <tr className="border-t border-border hover:bg-card-hover">
                                                <td className="w-full max-w-0 px-3 py-2">
                                                    <Link
                                                        href={`/chat/meetings/${meeting.id}`}
                                                        title={meeting.title}
                                                        className="block truncate font-medium text-foreground no-underline hover:underline"
                                                    >
                                                        {meeting.title}
                                                    </Link>
                                                    <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground lg:hidden">
                                                        {stateBadge(state)}
                                                        <span className="min-w-0 truncate">
                                                            {whenText(meeting)} - {hostText(meeting)}
                                                        </span>
                                                    </span>
                                                    <span className="mt-0.5 hidden truncate text-xs text-muted-foreground lg:block xl:hidden">
                                                        {hostText(meeting)}
                                                    </span>
                                                    {meeting.people.length > 0 && (
                                                        <span className="mt-1.5 block">
                                                            <CallRoster people={meeting.people} />
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="hidden whitespace-nowrap px-3 py-2 text-muted-foreground lg:table-cell">
                                                    {whenText(meeting)}
                                                </td>
                                                <td className="hidden max-w-48 truncate px-3 py-2 text-muted-foreground xl:table-cell">
                                                    {hostText(meeting)}
                                                </td>
                                                <td className="hidden px-3 py-2 lg:table-cell">
                                                    {stateBadge(state)}
                                                </td>
                                                <td className="px-3 py-2">
                                                    <div className="flex items-center justify-end gap-1">
                                                        <Button
                                                            size="xs"
                                                            variant={state === "live" ? "primary" : "secondary"}
                                                            title={joinLabel(meeting, state)}
                                                            aria-label={joinLabel(meeting, state)}
                                                            onClick={() => join(meeting)}
                                                        >
                                                            <Video className="size-3.5 shrink-0" />
                                                            <span className="hidden sm:inline">
                                                                {joinLabel(meeting, state)}
                                                            </span>
                                                        </Button>
                                                        <RowActionsMenu
                                                            title={meeting.title}
                                                            label={t("meetings.actionsFor", {
                                                                name: meeting.title
                                                            })}
                                                            actions={actions}
                                                        />
                                                    </div>
                                                </td>
                                            </tr>
                                        </RowContextMenu>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <MeetingDetailsDialog
                open={editing !== null}
                meetingId={editing?.id ?? ""}
                title={editing?.title ?? ""}
                scheduledAt={editing?.scheduledAt ?? null}
                onClose={() => setEditing(null)}
                onSaved={reload}
                onError={setError}
            />

            <NewMeetingDialog
                open={creating}
                onClose={() => setCreating(false)}
                onCreated={(meetingId) => {
                    setCreating(false);
                    lastAnswers.clear();
                    router.push(`/chat/meetings/${meetingId}`);
                }}
                onError={setError}
            />

            {confirmElement}
        </div>
    );
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
    const t = useTranslations("chat");
    const [title, setTitle] = useState("");
    const [when, setWhen] = useState("");
    const [approveGuests, setApproveGuests] = useState(true);
    const [requireAccount, setRequireAccount] = useState(false);
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [emails, setEmails] = useState<readonly string[]>([]);
    const [emailDraft, setEmailDraft] = useState("");
    const [emailError, setEmailError] = useState("");
    const [joinCode, setJoinCode] = useState(false);
    const [busy, setBusy] = useState(false);

    // Emptied on the way in rather than on the way out, so a dialog reopened
    // after a mistake is not still holding the mistake.
    useEffect(() => {
        if (!open) return;
        setTitle("");
        setWhen("");
        setApproveGuests(true);
        setRequireAccount(false);
        setPicked([]);
        setEmails([]);
        setEmailDraft("");
        setEmailError("");
        setJoinCode(false);
    }, [open]);

    const create = async () => {
        // Accounts only takes no addresses, and the field says so instead of
        // offering itself; anything left over from before the switch is not sent.
        const sending = requireAccount ? [] : withDraft(emails, emailDraft);
        if (sending === null) {
            setEmailError(t("meetingInvites.notAnEmail"));
            return;
        }
        if (sending.length > MOST_EMAILS) {
            setEmailError(t("meetingInvites.tooManyEmails", { count: MOST_EMAILS }));
            return;
        }
        setEmailError("");
        setBusy(true);
        const result = await runAction(
            () =>
                createMeetingAction({
                    title,
                    // The field is a local time and the server is nowhere, so it
                    // is turned into a moment here, where the reader's clock is.
                    scheduledAt: when ? new Date(when).toISOString() : null,
                    approveGuests,
                    requireAccount,
                    userIds: picked.map((person) => person.id),
                    emails: sending,
                    joinCode
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
                    <DialogTitle>{t("meetings.newMeeting")}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">
                            {t("meetings.name")}
                            <span className="text-danger"> *</span>
                        </span>
                        <Input
                            autoFocus
                            value={title}
                            maxLength={MAX_MEETING_TITLE}
                            placeholder={t("meetings.whatItIsAbout")}
                            onChange={(event) => setTitle(event.target.value)}
                        />
                    </label>

                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">{t("meetings.when")}</span>
                        <DateInput
                            mode="datetime"
                            value={when}
                            onChange={(event) => setWhen(event.target.value)}
                        />
                        <span className="text-[0.6875rem] text-muted-foreground">
                            {t("meetings.leaveItEmptyForA")}
                        </span>
                    </label>

                    <Setting
                        label={t("meetings.letPeopleInYourself")}
                        hint={t("meetings.anybodyOnTheLinkWaits")}
                        checked={approveGuests}
                        onChange={setApproveGuests}
                    />
                    <Setting
                        label={t("meetings.polarisAccountsOnly")}
                        hint={t("meetings.theLinkNamesTheMeeting")}
                        checked={requireAccount}
                        onChange={setRequireAccount}
                    />
                    <Setting
                        label={t("meetingInvites.joinCode")}
                        hint={t("meetingInvites.joinCodeHint")}
                        checked={joinCode}
                        onChange={setJoinCode}
                    />

                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">{t("meetingInvites.people")}</span>
                        <PeoplePicker
                            picked={picked}
                            onChange={setPicked}
                            search={(query) => searchPeopleAction(query)}
                        />
                        <span className="text-[0.6875rem] text-muted-foreground">
                            {approveGuests
                                ? t("meetingInvites.peopleSkipLobby")
                                : t("meetingInvites.peopleHint")}
                        </span>
                    </div>
                    <EmailInvitesField
                        emails={emails}
                        onChange={setEmails}
                        draft={emailDraft}
                        onDraftChange={(next) => {
                            setEmailDraft(next);
                            setEmailError("");
                        }}
                        disabledReason={
                            requireAccount ? t("meetingInvites.emailsNeedGuests") : undefined
                        }
                    />
                    {emailError && (
                        <p role="alert" className="text-[0.6875rem] text-danger">
                            {emailError}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        {t("meetings.cancel")}
                    </Button>
                    <Button
                        size="sm"
                        disabled={busy || !title.trim()}
                        onClick={() => void create()}
                    >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("meetings.create")}
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
                <span className="block text-[0.6875rem] text-muted-foreground">{hint}</span>
            </span>
            <Switch checked={checked} onChange={onChange} aria-label={label} />
        </label>
    );
}

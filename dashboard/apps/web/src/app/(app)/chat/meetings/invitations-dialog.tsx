"use client";

/**
 * A standing meeting's invitations, changed from its own page: who is asked,
 * which addresses are on the list, and the join code.
 *
 * The host's alone - the page only draws it for them (`MeetingSummary.mine`, the
 * same host check every action below makes on the server). Each change shows at
 * once and is put back if the server refuses it.
 */

import { Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import type { MeetingSummary } from "@/lib/chat/meetings";
import { searchPeopleAction } from "@/app/(app)/chat/actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { EmailInvitesField, InvitedPeople, JoinCodeBadge, withDraft } from "./meeting-invitation";
import {
    inviteToMeetingAction,
    setJoinCodeAction,
    uninviteEmailFromMeetingAction,
    uninviteFromMeetingAction
} from "@/app/(app)/chat/meeting-actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

type SetMeeting = Dispatch<SetStateAction<MeetingSummary | null>>;

/**
 * The edits, each optimistic: the change is drawn first, and undone - only that
 * change, so a poll that landed meanwhile is not thrown away - when the server
 * says no. `reload` re-reads the meeting afterwards so the screen ends on what is
 * stored.
 */
export function useInvitationEdits(
    meetingId: string,
    setMeeting: SetMeeting,
    reload: () => Promise<void>,
    onError: (message: string) => void
) {
    const edit = useCallback(
        (change: (meeting: MeetingSummary) => MeetingSummary): void =>
            setMeeting((meeting) => (meeting ? change(meeting) : meeting)),
        [setMeeting]
    );

    const removePerson = useCallback(
        async (person: { id: string; name: string }): Promise<void> => {
            edit((m) => ({ ...m, invited: m.invited.filter((p) => p.id !== person.id) }));
            const result = await runAction(
                () => uninviteFromMeetingAction(meetingId, person.id),
                onError
            );
            if (!result || result.error) {
                edit((m) =>
                    m.invited.some((p) => p.id === person.id)
                        ? m
                        : { ...m, invited: [...m.invited, person] }
                );
            }
            await reload();
        },
        [edit, meetingId, onError, reload]
    );

    const removeEmail = useCallback(
        async (email: string): Promise<void> => {
            edit((m) => ({ ...m, invitedEmails: m.invitedEmails.filter((e) => e !== email) }));
            const result = await runAction(
                () => uninviteEmailFromMeetingAction({ meetingId, email }),
                onError
            );
            if (!result || result.error) {
                edit((m) =>
                    m.invitedEmails.includes(email)
                        ? m
                        : { ...m, invitedEmails: [...m.invitedEmails, email] }
                );
            }
            await reload();
        },
        [edit, meetingId, onError, reload]
    );

    /** Add people and addresses not already on the list. True when the server
     *  took them. */
    const add = useCallback(
        async (people: readonly PickedPerson[], emails: readonly string[]): Promise<boolean> => {
            edit((m) => ({
                ...m,
                invited: [...m.invited, ...people],
                invitedEmails: [...m.invitedEmails, ...emails]
            }));
            const result = await runAction(
                () =>
                    inviteToMeetingAction({
                        meetingId,
                        userIds: people.map((person) => person.id),
                        emails
                    }),
                onError
            );
            const ok = Boolean(result && !result.error);
            if (!ok) {
                edit((m) => ({
                    ...m,
                    invited: m.invited.filter((p) => !people.some((a) => a.id === p.id)),
                    invitedEmails: m.invitedEmails.filter((e) => !emails.includes(e))
                }));
            }
            await reload();
            return ok;
        },
        [edit, meetingId, onError, reload]
    );

    /** Draw a new code (on) or take it away. Removing is drawn at once; a new
     *  code cannot be, since only the server draws it. */
    const setCode = useCallback(
        async (on: boolean, was: string | null): Promise<void> => {
            if (!on) edit((m) => ({ ...m, joinCode: null }));
            const result = await runAction(() => setJoinCodeAction({ meetingId, on }), onError);
            if (!result || result.error) edit((m) => ({ ...m, joinCode: was }));
            else edit((m) => ({ ...m, joinCode: result.joinCode ?? null }));
            await reload();
        },
        [edit, meetingId, onError, reload]
    );

    return { removePerson, removeEmail, add, setCode };
}

export type InvitationEdits = ReturnType<typeof useInvitationEdits>;

export function InvitationsDialog({
    open,
    meeting,
    viewerId,
    edits,
    onClose
}: {
    open: boolean;
    meeting: MeetingSummary;
    viewerId: string;
    edits: InvitationEdits;
    onClose: () => void;
}) {
    const t = useTranslations("chat");
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [emails, setEmails] = useState<readonly string[]>([]);
    const [draft, setDraft] = useState("");
    const [adding, setAdding] = useState(false);
    /** Which code change is waiting to be confirmed, shown in place rather
     *  than as a second dialog over this one. */
    const [asking, setAsking] = useState<"replace" | "remove" | null>(null);
    const [coding, setCoding] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked([]);
        setEmails([]);
        setDraft("");
        setAsking(null);
    }, [open]);

    const typed = withDraft(emails, draft);
    const canAdd = !adding && typed !== null && picked.length + typed.length > 0;
    const nobody = meeting.invited.length === 0 && meeting.invitedEmails.length === 0;

    const add = async (): Promise<void> => {
        if (!typed) return;
        setAdding(true);
        // Only what is not on the list yet, so a refusal takes back nothing
        // that was there before.
        const fresh = meeting.requireAccount
            ? []
            : typed.filter((email) => !meeting.invitedEmails.includes(email));
        const people = picked.filter(
            (person) => !meeting.invited.some((other) => other.id === person.id)
        );
        if (people.length + fresh.length === 0) {
            setPicked([]);
            setEmails([]);
            setDraft("");
            return setAdding(false);
        }
        const ok = await edits.add(people, fresh);
        setAdding(false);
        if (!ok) return;
        setPicked([]);
        setEmails([]);
        setDraft("");
    };

    const code = async (on: boolean): Promise<void> => {
        setAsking(null);
        setCoding(true);
        await edits.setCode(on, meeting.joinCode);
        setCoding(false);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("meetingInvites.manage")}</DialogTitle>
                    <DialogDescription>{t("meetingInvites.manageHint")}</DialogDescription>
                </DialogHeader>

                <div className="flex min-w-0 flex-col gap-5">
                    {nobody ? (
                        <p className="text-xs text-muted-foreground">
                            {t("meetingInvites.nobodyYet")}
                        </p>
                    ) : (
                        <InvitedPeople
                            meeting={meeting}
                            onRemovePerson={(person) => void edits.removePerson(person)}
                            onRemoveEmail={(email) => void edits.removeEmail(email)}
                        />
                    )}

                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium">{t("meetingInvites.addPeople")}</span>
                        <p className="text-[0.6875rem] text-muted-foreground">
                            {t("meetingInvites.addPeopleHint")}
                        </p>
                        <PeoplePicker
                            picked={picked}
                            onChange={setPicked}
                            exclude={[viewerId, ...meeting.invited.map((person) => person.id)]}
                            search={(query) => searchPeopleAction(query)}
                        />
                        <EmailInvitesField
                            emails={emails}
                            onChange={setEmails}
                            draft={draft}
                            onDraftChange={setDraft}
                            disabledReason={
                                meeting.requireAccount
                                    ? t("meetingInvites.emailsNeedGuests")
                                    : undefined
                            }
                        />
                        <div className="flex justify-end">
                            <Button size="sm" disabled={!canAdd} onClick={() => void add()}>
                                {adding && <Loader2 className="size-4 animate-spin" />}
                                {t("meetingInvites.add")}
                            </Button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium">{t("meetingInvites.joinCode")}</span>
                        {asking ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                                    {asking === "replace"
                                        ? t("meetingInvites.replaceCodeQuestion")
                                        : t("meetingInvites.removeCodeQuestion")}
                                </p>
                                <Button
                                    size="xs"
                                    variant="secondary"
                                    onClick={() => setAsking(null)}
                                >
                                    {t("meetingInvites.back")}
                                </Button>
                                <Button
                                    size="xs"
                                    variant="danger"
                                    onClick={() => void code(asking === "replace")}
                                >
                                    {asking === "replace"
                                        ? t("meetingInvites.replaceCode")
                                        : t("meetingInvites.confirmRemoveCode")}
                                </Button>
                            </div>
                        ) : meeting.joinCode ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <JoinCodeBadge code={meeting.joinCode} />
                                <span className="flex-1" />
                                <Button
                                    size="xs"
                                    variant="secondary"
                                    disabled={coding}
                                    onClick={() => setAsking("replace")}
                                >
                                    {coding && <Loader2 className="size-3.5 animate-spin" />}
                                    {t("meetingInvites.newCode")}
                                </Button>
                                <Button
                                    size="xs"
                                    variant="secondary"
                                    disabled={coding}
                                    onClick={() => setAsking("remove")}
                                >
                                    {t("meetingInvites.removeCode")}
                                </Button>
                            </div>
                        ) : (
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                                    {t("meetingInvites.noCode")}
                                </p>
                                <Button
                                    size="xs"
                                    variant="secondary"
                                    disabled={coding}
                                    onClick={() => void code(true)}
                                >
                                    {coding && <Loader2 className="size-3.5 animate-spin" />}
                                    {t("meetingInvites.addCode")}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button size="sm" variant="secondary" onClick={onClose}>
                        {t("meetingInvites.done")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

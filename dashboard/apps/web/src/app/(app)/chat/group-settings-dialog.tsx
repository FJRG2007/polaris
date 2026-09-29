"use client";

/**
 * What the owner of a group decides about it.
 *
 * A group has no administrators - everybody in one is equal in it, which is what
 * makes it a group rather than a channel - so it has an owner instead: whoever
 * started it, until they hand it over. Four things are theirs and nobody else's:
 * whether the rest of the group may change how it looks, whether they may add
 * people, whether they may use `@everyone` and `@here`, and who runs it next.
 *
 * Only shown to the owner. A screen that offers a switch the server will refuse
 * is worse than one that does not offer it, and the owner is the only person for
 * whom either of these is a question.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { PersonName, PersonRow, PlainNames } from "@/components/person-name";
import type { ChatChannelView, ChatMemberView } from "@/lib/chat/chat-service";
import { listMembersAction, setGroupOptionsAction, transferGroupAction } from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Switch
} from "@polaris/ui";

interface GroupOptions {
    membersMayEdit?: boolean;
    membersMayInvite?: boolean;
    membersMayMention?: boolean;
}

export function GroupSettingsDialog({
    channel,
    open,
    onOpenChange,
    onChanged
}: {
    channel: ChatChannelView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
}) {
    const t = useTranslations("chat");
    const [members, setMembers] = useState<readonly ChatMemberView[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [handingTo, setHandingTo] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setHandingTo(null);
        setError("");
        void listMembersAction(channel.id).then((result) => setMembers(result.members ?? []));
    }, [open, channel.id]);

    const others = members.filter((member) => member.userId !== channel.ownerId);

    // Shown as flipped while the server answers, and put back if it refuses.
    const [pending, setPending] = useState<GroupOptions>({});
    useEffect(
        () => setPending({}),
        [channel.membersMayEdit, channel.membersMayInvite, channel.membersMayMention]
    );
    const shown = {
        membersMayEdit: pending.membersMayEdit ?? channel.membersMayEdit,
        membersMayInvite: pending.membersMayInvite ?? channel.membersMayInvite,
        membersMayMention: pending.membersMayMention ?? channel.membersMayMention
    };

    const setSwitch = async (change: GroupOptions) => {
        setBusy(true);
        setError("");
        setPending((was) => ({ ...was, ...change }));
        const result = await runAction(() => setGroupOptionsAction(channel.id, change), setError);
        setBusy(false);
        if (!result || result.error) {
            // Said, not only undone: `runAction` reports what throws, and this
            // action answers with its refusal instead of throwing it.
            if (result?.error) setError(result.error);
            setPending({});
            return;
        }
        onChanged();
    };

    const hand = async (userId: string) => {
        setBusy(true);
        setError("");
        const result = await runAction(() => transferGroupAction(channel.id, userId), setError);
        setBusy(false);
        if (!result || result.error) return;
        setHandingTo(null);
        onChanged();
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("groupSettings.groupSettings")}</DialogTitle>
                    <DialogDescription>
                        {t("groupSettings.yoursBecauseYouRunThis")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex items-start justify-between gap-3">
                        <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">
                                {t("groupSettings.letAnybodyChangeTheName")}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {t("groupSettings.offOnlyYouCanOn")}
                            </span>
                        </span>
                        <Switch
                            checked={shown.membersMayEdit}
                            disabled={busy}
                            onChange={(next: boolean) => void setSwitch({ membersMayEdit: next })}
                            aria-label={t("groupSettings.letAnybodyChangeTheName")}
                        />
                    </label>

                    <label className="flex items-start justify-between gap-3">
                        <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">{t("groupSettings.letAnybodyAddPeople")}</span>
                            <span className="text-xs text-muted-foreground">
                                {t("groupSettings.offOnlyYouCanAdd")}
                            </span>
                        </span>
                        <Switch
                            checked={shown.membersMayInvite}
                            disabled={busy}
                            onChange={(next: boolean) => void setSwitch({ membersMayInvite: next })}
                            aria-label={t("groupSettings.letAnybodyAddPeople")}
                        />
                    </label>

                    <label className="flex items-start justify-between gap-3">
                        <span className="flex min-w-0 flex-col">
                            <span className="text-sm font-medium">
                                {t("groupSettings.letAnybodyUseEveryoneAnd")}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {t("groupSettings.offOnlyYouCanNotify")}
                            </span>
                        </span>
                        <Switch
                            checked={shown.membersMayMention}
                            disabled={busy}
                            onChange={(next: boolean) =>
                                void setSwitch({ membersMayMention: next })
                            }
                            aria-label={t("groupSettings.letAnybodyUseEveryoneAnd")}
                        />
                    </label>

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">{t("groupSettings.handTheGroupOver")}</span>
                        <span className="text-xs text-muted-foreground">
                            {t("groupSettings.theyRunItFromThen")}
                        </span>
                        {others.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                {t("groupSettings.thereIsNobodyElseIn")}
                            </p>
                        ) : (
                            // Plain: this is where somebody is chosen to own the
                            // group, and a plate or a coloured name is not what
                            // tells two members apart - the name they go by is.
                            <PlainNames>
                                <ul className="flex flex-col gap-1">
                                    {others.map((member) => (
                                        <PersonRow
                                            as="li"
                                            key={member.userId}
                                            personId={member.userId}
                                            className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                                        >
                                            <Avatar
                                                size={24}
                                                person={{ id: member.userId, name: member.name }}
                                            />
                                            <span className="min-w-0 flex-1 truncate text-sm">
                                                <PersonName id={member.userId} name={member.name} />
                                            </span>
                                            {handingTo === member.userId ? (
                                                <>
                                                    {/* Asked twice, because it cannot be
                                                    undone from this side: the person
                                                    it went to is the only one who can
                                                    hand it back. */}
                                                    <Button
                                                        size="xs"
                                                        variant="danger"
                                                        disabled={busy}
                                                        onClick={() => void hand(member.userId)}
                                                    >
                                                        {t("groupSettings.handItOver")}
                                                    </Button>
                                                    <Button
                                                        size="xs"
                                                        variant="ghost"
                                                        disabled={busy}
                                                        onClick={() => setHandingTo(null)}
                                                    >
                                                        {t("groupSettings.cancel")}
                                                    </Button>
                                                </>
                                            ) : (
                                                <Button
                                                    size="xs"
                                                    variant="secondary"
                                                    disabled={busy}
                                                    onClick={() => setHandingTo(member.userId)}
                                                >
                                                    {t("groupSettings.makeOwner")}
                                                </Button>
                                            )}
                                        </PersonRow>
                                    ))}
                                </ul>
                            </PlainNames>
                        )}
                    </div>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("groupSettings.close")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

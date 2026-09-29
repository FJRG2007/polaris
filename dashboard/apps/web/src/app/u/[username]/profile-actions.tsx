"use client";

/**
 * What one person can do about another, from their page.
 *
 * One thing to press, one thing beside it, and everything else behind three
 * dots. Which is which is the whole design, and it changed once because the
 * first version had it wrong: "Friends" sat there as a button of its own, so the
 * most prominent control on somebody's page was the one that stops being their
 * friend. Nobody opens a profile to do that.
 *
 * So the front of the card carries what somebody came to do - ask to be added,
 * and once they are, write to them - and Follow beside it, which is the smaller,
 * one-sided version of the same intent. Removing a friend, blocking and
 * reporting go under the menu, where the heavy things live in every other list
 * of people here.
 *
 * A message is offered to friends and nobody else: following somebody is not a
 * relationship they agreed to, and a conversation opened by a stranger is what a
 * block list exists because of.
 *
 * Every one of these is a way into something that already exists in Polaris -
 * the friends service, the block list, the report dialog the chat uses - so no
 * refusal, rate limit or block is re-decided here.
 */

import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { openDirectAction } from "@/app/(app)/chat/actions";
import type { ProfileStanding } from "@/lib/profile-service";
import { ReportPersonDialog } from "@/components/report-person-dialog";
import { blockPersonAction, unblockPersonAction } from "@/app/(app)/account/privacy/actions";
import {
    askToBeFriendsAction,
    followAction,
    stopBeingFriendsAction,
    unfollowAction
} from "./actions";
import { Check, Flag, MessageSquare, MoreHorizontal, ShieldBan, UserMinus, UserPlus } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

export function ProfileActions({
    personId,
    name,
    standing
}: {
    personId: string;
    name: string;
    standing: ProfileStanding;
}) {
    const router = useRouter();
    const [confirm, confirmElement] = useConfirm();
    const t = useTranslations("publicPages");
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState("");
    const [reporting, setReporting] = useState(false);
    // Applied on the press and put back if the server refuses: these are toggles,
    // and one that waits for a round trip before it changes reads as one that did
    // not work.
    const [following, setFollowing] = useState(standing.following);
    const [friendship, setFriendship] = useState(standing.friendship);
    const [blocked, setBlocked] = useState(standing.blocked);

    const run = (job: () => Promise<{ error?: string }>, undo: () => void) => {
        setError("");
        startTransition(async () => {
            const result = await runAction(job, setError);
            if (!result || result.error) {
                undo();
                if (result?.error) setError(result.error);
                return;
            }
            router.refresh();
        });
    };

    const toggleFollow = () => {
        const next = !following;
        setFollowing(next);
        run(
            () => (next ? followAction({ personId }) : unfollowAction({ personId })),
            () => setFollowing(!next)
        );
    };

    const ask = () => {
        setFriendship("sent");
        run(
            () => askToBeFriendsAction({ personId }),
            () => setFriendship(standing.friendship)
        );
    };

    const drop = async () => {
        const sure = await confirm({
            title: t("profile.dropTitle", { name }),
            description: t("profile.dropDescription"),
            confirmLabel: t("profile.drop"),
            danger: true
        });
        if (!sure) return;
        setFriendship("none");
        run(
            () => stopBeingFriendsAction({ personId }),
            () => setFriendship(standing.friendship)
        );
    };

    /**
     * Shut them out, or let them back in.
     *
     * Blocking is confirmed and unblocking is not: one of them takes something
     * away and the other gives it back, and asking twice about the harmless
     * direction is how a confirmation stops being read.
     */
    const toggleBlock = async () => {
        if (!blocked) {
            const sure = await confirm({
                title: t("profile.blockTitle", { name }),
                description: t("profile.blockDescription"),
                confirmLabel: t("profile.blockConfirm"),
                danger: true
            });
            if (!sure) return;
        }
        const next = !blocked;
        setBlocked(next);
        run(
            () => (next ? blockPersonAction({ userId: personId }) : unblockPersonAction({ userId: personId })),
            () => setBlocked(!next)
        );
    };

    const message = () => {
        setError("");
        startTransition(async () => {
            const result = await runAction(() => openDirectAction({ userIds: [personId] }), setError);
            if (result?.id) router.push(`/chat/c/${result.id}`);
        });
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                {/* Blocked: nothing is offered about somebody this reader shut
                    out beyond letting them back in, so the row says that and
                    stops. */}
                {blocked ? (
                    <span className="text-muted-foreground text-sm">{t("profile.youBlocked", { name })}</span>
                ) : (
                    <>
                        {friendship === "friends" ? (
                            <Button size="sm" disabled={pending} onClick={message}>
                                <MessageSquare className="size-3.5 shrink-0" />
                                {t("profile.message")}
                            </Button>
                        ) : friendship === "sent" ? (
                            // Not a button: the request is out and only they can
                            // answer it, so a control here would do nothing.
                            <span className="text-muted-foreground text-sm">{t("profile.requestSent")}</span>
                        ) : friendship === "received" ? (
                            <Button size="sm" asChild>
                                <a href="/account/friends">{t("profile.answer")}</a>
                            </Button>
                        ) : standing.canAskToBeFriends ? (
                            <Button size="sm" disabled={pending} onClick={ask}>
                                <UserPlus className="size-3.5 shrink-0" />
                                {t("profile.addFriend")}
                            </Button>
                        ) : null}

                        <Button
                            size="sm"
                            variant={following ? "secondary" : "outline"}
                            disabled={pending}
                            onClick={toggleFollow}
                        >
                            {following ? (
                                <>
                                    <Check className="size-3.5 shrink-0" />
                                    {t("profile.following")}
                                </>
                            ) : (
                                t("profile.follow")
                            )}
                        </Button>
                    </>
                )}

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("profile.moreAbout", { name })}
                            title={t("profile.more")}
                            disabled={pending}
                        >
                            <MoreHorizontal className="size-4 shrink-0" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                        {friendship === "friends" && !blocked ? (
                            <>
                                <DropdownMenuItem className="gap-2" onSelect={() => void drop()}>
                                    <UserMinus className="size-3.5" />
                                    {t("profile.removeFriend")}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                            </>
                        ) : null}
                        <DropdownMenuItem
                            variant={blocked ? undefined : "danger"}
                            className="gap-2"
                            onSelect={() => void toggleBlock()}
                        >
                            <ShieldBan className="size-3.5" />
                            {blocked ? t("profile.unblock") : t("profile.block")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            variant="danger"
                            className="gap-2"
                            onSelect={() => setReporting(true)}
                        >
                            <Flag className="size-3.5" />
                            {t("profile.report")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {error ? <p className="text-danger text-xs">{error}</p> : null}
            <ReportPersonDialog
                open={reporting}
                person={{ id: personId, name }}
                onOpenChange={setReporting}
            />
            {confirmElement}
        </div>
    );
}

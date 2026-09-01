"use client";

/**
 * What one person can do about another, from their page.
 *
 * Three buttons, and the whole design is in which is which. Following is
 * one-sided and instant: nobody is asked, nothing is granted, and it is the
 * thing somebody does when they want to see what another person puts out.
 * Adding as a friend is a request the other side answers, and it changes what
 * each of them may see of the other. A message is offered to friends and to
 * nobody else - somebody following you has not entered into anything you agreed
 * to, and a conversation opened by a stranger is what a block list exists
 * because of.
 *
 * Every one of them is a way into something that already exists elsewhere in
 * Polaris. Nothing here re-decides a refusal, a block or a rate limit.
 */

import { Button } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { openDirectAction } from "@/app/(app)/chat/actions";
import type { ProfileStanding } from "@/lib/profile-service";
import { Check, MessageSquare, UserMinus, UserPlus } from "lucide-react";
import {
    askToBeFriendsAction,
    followAction,
    stopBeingFriendsAction,
    unfollowAction
} from "./actions";

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
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState("");
    // Applied on the press and put back if the server refuses: following is a
    // toggle, and a button that waits for a round trip before it changes reads
    // as a button that did not work.
    const [following, setFollowing] = useState(standing.following);
    const [friendship, setFriendship] = useState(standing.friendship);

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
            title: `Stop being friends with ${name}?`,
            description:
                "They lose what you show your friends and keep everything else. Either of you can ask again.",
            confirmLabel: "Stop being friends",
            danger: true
        });
        if (!sure) return;
        setFriendship("none");
        run(
            () => stopBeingFriendsAction({ personId }),
            () => setFriendship(standing.friendship)
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
                <Button size="sm" variant={following ? "secondary" : "primary"} disabled={pending} onClick={toggleFollow}>
                    {following ? (
                        <>
                            <Check className="size-3.5 shrink-0" />
                            Following
                        </>
                    ) : (
                        "Follow"
                    )}
                </Button>

                {friendship === "friends" ? (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => void drop()}>
                        <UserMinus className="size-3.5 shrink-0" />
                        Friends
                    </Button>
                ) : friendship === "sent" ? (
                    // Not a button. The request is out and only they can answer
                    // it, so a control here would be a control that does nothing.
                    <span className="text-muted-foreground text-xs">Friend request sent</span>
                ) : friendship === "received" ? (
                    <Button size="sm" variant="outline" asChild>
                        <a href="/account/friends">They asked to be added - answer it</a>
                    </Button>
                ) : (
                    <Button size="sm" variant="outline" disabled={pending} onClick={ask}>
                        <UserPlus className="size-3.5 shrink-0" />
                        Add as a friend
                    </Button>
                )}

                {standing.canMessage ? (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={message}>
                        <MessageSquare className="size-3.5 shrink-0" />
                        Message
                    </Button>
                ) : null}
            </div>
            {error ? <p className="text-danger text-xs">{error}</p> : null}
            {confirmElement}
        </div>
    );
}

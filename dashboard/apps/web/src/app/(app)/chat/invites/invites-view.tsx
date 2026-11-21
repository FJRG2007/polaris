"use client";

/**
 * Pending group invitations, each with Join and Decline.
 *
 * Answering takes the row off at once and puts it back if the server refuses -
 * an invitation the server says is gone stays gone, since there is nothing left
 * to answer.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { GroupInviteView } from "@/lib/chat/group-invites";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, EmptyState, Skeleton, useToast } from "@polaris/ui";
import {
    acceptGroupInviteAction,
    declineGroupInviteAction,
    listGroupInvitesAction
} from "../actions";

export function InvitesView() {
    const t = useTranslations("chat");
    const toast = useToast();
    const router = useRouter();
    const [invites, setInvites] = useState<GroupInviteView[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(() => {
        setFailed(false);
        listGroupInvitesAction().then(
            (result) => setInvites(result.invites),
            () => setFailed(true)
        );
    }, []);
    useEffect(load, [load]);

    const answer = async (invite: GroupInviteView, accept: boolean) => {
        if (busy) return;
        setBusy(invite.id);
        const before = invites;
        setInvites((current) => current?.filter((row) => row.id !== invite.id) ?? null);
        try {
            if (accept) {
                const result = await acceptGroupInviteAction(invite.id);
                if (result.channelId) {
                    router.push(`/chat/c/${result.channelId}`);
                    return;
                }
                toast.show({ key: `group-invite-${invite.id}`, title: result.error ?? "" });
                // A full group can make room later; anything else is gone.
                if (result.error === t("errors.groupInviteGone")) return;
                setInvites(before);
            } else {
                const result = await declineGroupInviteAction(invite.id);
                if (result.error) {
                    toast.show({ key: `group-invite-${invite.id}`, title: result.error });
                    if (result.error !== t("errors.groupInviteGone")) setInvites(before);
                }
            }
        } catch {
            toast.show({ key: `group-invite-${invite.id}`, title: t("groupInvites.failed") });
            setInvites(before);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
            <div className="flex min-w-0 items-center gap-2">
                <Button size="sm" variant="ghost" asChild>
                    <Link href="/chat" aria-label={t("groupInvites.back")}>
                        <ArrowLeft className="size-4 shrink-0" />
                    </Link>
                </Button>
                <h1 className="min-w-0 truncate text-[1.0625rem] font-semibold tracking-tight">
                    {t("groupInvites.title")}
                </h1>
            </div>
            {failed ? (
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                    <span className="min-w-0 flex-1">{t("groupInvites.loadFailed")}</span>
                    <Button size="sm" variant="secondary" onClick={load}>
                        {t("groupInvites.retry")}
                    </Button>
                </div>
            ) : invites === null ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                    {[0, 1, 2].map((row) => (
                        <Skeleton key={row} className="h-14 w-full" />
                    ))}
                </div>
            ) : invites.length === 0 ? (
                <EmptyState
                    icon={<Users />}
                    title={t("groupInvites.empty")}
                    description={t("groupInvites.emptyHint")}
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                    {invites.map((invite) => (
                        <li
                            key={invite.id}
                            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
                        >
                            <span className="min-w-0 flex-1">
                                <span
                                    className="block truncate text-[0.8125rem]"
                                    title={invite.groupName || t("groupInvites.unnamed")}
                                >
                                    {invite.groupName || t("groupInvites.unnamed")}
                                </span>
                                <span
                                    className="block truncate text-[0.6875rem] text-foreground-subtle"
                                    title={invite.inviterName}
                                >
                                    {t("groupInvites.from", { name: invite.inviterName })}
                                </span>
                            </span>
                            <span className="flex shrink-0 gap-2">
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy !== null}
                                    onClick={() => void answer(invite, false)}
                                >
                                    {t("groupInvites.decline")}
                                </Button>
                                <Button
                                    size="sm"
                                    disabled={busy !== null}
                                    onClick={() => void answer(invite, true)}
                                >
                                    {t("groupInvites.join")}
                                </Button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

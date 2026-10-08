"use client";

/**
 * The card that asks somebody whether to join.
 *
 * Deliberately not a page that joins on arrival. A link that added you to a
 * space the moment you opened it would mean a forwarded link put people in
 * rooms they never chose to be in, and there would be no moment at which
 * anybody could decline.
 *
 * A refused invitation still names the space. "This link has expired" on its own
 * tells somebody nothing they can act on; with the name beside it they know who
 * to go back to.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { ChatInviteOffer } from "@/lib/chat/invites";
import { Button, EmptyState, Skeleton } from "@polaris/ui";
import { Loader2, MessageSquare, TriangleAlert } from "lucide-react";
import { acceptInviteAction, readInviteAction } from "@/app/(app)/chat/actions";

export function InviteView({ code }: { code: string }) {
    const t = useTranslations("chat");
    const router = useRouter();
    const [offer, setOffer] = useState<ChatInviteOffer | null | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        void readInviteAction(code).then((result) => {
            setOffer(result.offer ?? null);
            setError(result.error ?? "");
        });
    }, [code]);

    const accept = async () => {
        setBusy(true);
        setError("");
        const result = await runAction(() => acceptInviteAction(code), setError);
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        // The rail keeps its own list, so this is a navigation and a reload: the
        // space is new to this browser and nothing else would put it there.
        // Onto the channel the link named, Discord's way, or the space itself.
        router.push(result.channelId ? `/chat/c/${result.channelId}` : "/chat");
        router.refresh();
    };

    if (offer === undefined) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <div className="flex w-72 flex-col items-center gap-3" aria-hidden="true">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-3 w-56" />
                    <Skeleton className="h-8 w-28" />
                </div>
            </div>
        );
    }

    if (offer === null) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState
                    icon={<TriangleAlert />}
                    title={t("inviteView.thatInvitationDoesNotLead")}
                    description={
                        error ||
                        t("inviteView.itMayHaveBeenWithdrawn")
                    }
                />
            </div>
        );
    }

    return (
        <div className="flex flex-1 items-center justify-center p-6">
            <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border border-border bg-card p-6 text-center">
                <MessageSquare className="size-8 text-muted-foreground" />
                <div className="flex flex-col gap-1">
                    <p className="text-[1.0625rem] font-semibold tracking-tight">{offer.spaceName}</p>
                    {offer.spaceDescription && (
                        <p className="text-sm text-muted-foreground">{offer.spaceDescription}</p>
                    )}
                    {offer.channelName && (
                        <p className="min-w-0 truncate text-sm text-foreground" title={offer.channelName}>
                            {t("inviteView.opensOn", { name: offer.channelName })}
                        </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                        {offer.invitedBy
                            ? t("inviteView.invitedBy", { name: offer.invitedBy })
                            : t("inviteView.youHaveBeenInvited")}
                    </p>
                </div>

                {offer.alreadyIn ? (
                    <Button
                        size="sm"
                        onClick={() =>
                            router.push(offer.channelId ? `/chat/c/${offer.channelId}` : "/chat")
                        }
                    >
                        {t("inviteView.openIt")}
                    </Button>
                ) : offer.usable ? (
                    <Button size="sm" disabled={busy} onClick={() => void accept()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("inviteView.join", { name: offer.spaceName })}
                    </Button>
                ) : (
                    <p className="text-sm text-danger">
                        {t("inviteView.thisInvitationHasRunOut")}
                    </p>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </div>
        </div>
    );
}

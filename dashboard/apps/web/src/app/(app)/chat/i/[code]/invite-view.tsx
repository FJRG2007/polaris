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
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { ChatInviteOffer } from "@/lib/chat/invites";
import { Button, EmptyState, Skeleton } from "@polaris/ui";
import { Loader2, MessageSquare, TriangleAlert } from "lucide-react";
import { acceptInviteAction, readInviteAction } from "@/app/(app)/chat/actions";

export function InviteView({ code }: { code: string }) {
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
        router.push("/chat");
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
                    title="That invitation does not lead anywhere."
                    description={
                        error ||
                        "It may have been withdrawn, or the space it pointed at may be gone."
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
                    <p className="text-xs text-muted-foreground">
                        {offer.invitedBy
                            ? `${offer.invitedBy} invited you.`
                            : "You have been invited."}
                    </p>
                </div>

                {offer.alreadyIn ? (
                    <Button size="sm" onClick={() => router.push("/chat")}>
                        Open it
                    </Button>
                ) : offer.usable ? (
                    <Button size="sm" disabled={busy} onClick={() => void accept()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Join {offer.spaceName}
                    </Button>
                ) : (
                    <p className="text-sm text-danger">
                        This invitation has run out. Ask whoever sent it for another.
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

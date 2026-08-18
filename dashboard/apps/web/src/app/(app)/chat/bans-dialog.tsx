"use client";

/**
 * Who is kept out of a space, and the way back in.
 *
 * A ban is the one moderation decision with no expiry and no reminder: a timeout
 * ends on its own and a removal is undone by an invitation, but this one sits
 * there until somebody goes looking for it. Without a list, "let them back in"
 * means remembering the name of somebody nobody has seen for six months and
 * asking an administrator to guess where the setting is.
 *
 * So it says who, why, and who decided - and lifting one is a press. Lifting
 * does not put them back in the space, which is not an omission: being allowed
 * in and being in are different things, and only they can decide the second.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { RelativeTime } from "@/components/relative-time";
import type { ChatBanView } from "@/lib/chat/chat-service";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Skeleton
} from "@polaris/ui";

export function BansDialog({
    space,
    onOpenChange
}: {
    /** The space whose bans these are. Null closes it - one prop rather than a
     *  boolean beside it, so the two cannot disagree. */
    space: { id: string; name: string } | null;
    onOpenChange: (open: boolean) => void;
}) {
    const [bans, setBans] = useState<readonly ChatBanView[] | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState("");

    const spaceId = space?.id ?? null;
    useEffect(() => {
        if (!spaceId) return;
        setBans(null);
        setError("");
        void actions.spaceBansAction(spaceId).then((result) => {
            if (result.error) setError(result.error);
            setBans(result.bans ?? []);
        });
    }, [spaceId]);

    const lift = async (userId: string) => {
        if (!spaceId) return;
        setBusy(userId);
        const result = await runAction(
            () => actions.liftSpaceBanAction(spaceId, userId),
            setError
        );
        setBusy(null);
        if (result?.error) return;
        // Taken off the list here rather than fetched again: one row changed,
        // and a reload would put a spinner over the nine that did not.
        setBans((current) => (current ?? []).filter((ban) => ban.userId !== userId));
    };

    return (
        <Dialog open={space !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Kept out of {space?.name}</DialogTitle>
                    <DialogDescription>
                        Letting somebody back in allows them to return. It does not put them back
                        in - that is theirs to decide.
                    </DialogDescription>
                </DialogHeader>

                {bans === null ? (
                    <div className="flex flex-col gap-2" aria-hidden="true">
                        {[0, 1, 2].map((row) => (
                            <div key={row} className="flex items-center gap-2">
                                <Skeleton className="size-7 rounded-full" />
                                <Skeleton className="h-3 w-40" />
                            </div>
                        ))}
                    </div>
                ) : bans.length === 0 ? (
                    <EmptyState
                        title="Nobody is kept out."
                        description="Banning somebody from this space puts them here, so they can be let back in."
                    />
                ) : (
                    <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                        {bans.map((ban) => (
                            <li
                                key={ban.userId}
                                className="flex items-center gap-2 rounded-md px-2 py-1.5"
                            >
                                <Avatar person={{ id: ban.userId, name: ban.name }} size={28} />
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-sm" title={ban.name}>{ban.name}</span>
                                    <span className="truncate text-[11px] text-muted-foreground">
                                        {ban.reason || "No reason given"}
                                        {ban.byName ? ` - ${ban.byName}` : ""},{" "}
                                        <RelativeTime iso={ban.at} />
                                    </span>
                                </span>
                                <Button
                                    size="xs"
                                    variant="secondary"
                                    disabled={busy !== null}
                                    onClick={() => void lift(ban.userId)}
                                >
                                    Let back in
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </DialogContent>
        </Dialog>
    );
}

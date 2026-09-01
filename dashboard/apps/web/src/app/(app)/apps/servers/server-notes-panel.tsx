"use client";

/**
 * What is known about one server that the machine cannot tell you: what has been
 * done to it, what people wrote down about it, and whether you hear about it.
 *
 * This is the third reader of the shared tables and the one they were argued for
 * - "this box drops its NAS mount every few weeks, do not bother rebooting it"
 * is knowledge that lived in somebody's head or in a task nobody could find from
 * the server.
 *
 * Only a registered server has any of it: the box Polaris runs on has no Host row
 * until it is enrolled, and until then there is no id to hang a history on. The
 * panel is not offered there rather than being offered and empty.
 */

import * as actions from "./actions";
import { Button, cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { Discussion } from "@/components/discussion";
import { describeServerEvent } from "./server-history";
import { ActivityFeed } from "@/components/activity-feed";
import type { CommentView } from "@/lib/comments/comments";
import type { ActivityLine } from "@/lib/activity/activity";

export function ServerNotesPanel({ hostId }: { hostId: string }) {
    const [notes, setNotes] = useState<CommentView[] | null>(null);
    const [history, setHistory] = useState<ActivityLine[] | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    function reload() {
        void actions.serverNotesAction(hostId).then(setNotes);
        void actions.serverHistoryAction(hostId).then(setHistory);
    }
    useEffect(reload, [hostId]);

    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-medium">Notes</h2>
                    <FollowToggle hostId={hostId} />
                </div>
                {error ? <p className="text-[0.8125rem] text-danger">{error}</p> : null}
                <Discussion
                    comments={notes}
                    canModerate
                    busy={busy}
                    placeholder="Leave a note about this server"
                    onPost={async (body) => {
                        setBusy(true);
                        setError("");
                        const result = await actions.postServerNoteAction({ hostId, body });
                        if (result.error) setError(result.error);
                        setBusy(false);
                        reload();
                    }}
                    onDelete={async (commentId) => {
                        setError("");
                        const result = await actions.deleteServerNoteAction({ hostId, commentId });
                        if (result.error) setError(result.error);
                        reload();
                    }}
                />
            </section>

            {history && history.length > 0 ? (
                <section className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium">History</h2>
                    <ActivityFeed lines={history} describe={describeServerEvent} />
                </section>
            ) : null}
        </div>
    );
}

/** Hear about this server, or stop. Optimistic, and rolled back if the server
 *  disagrees - the answer is a boolean it cannot half-apply. */
function FollowToggle({ hostId }: { hostId: string }) {
    const [following, setFollowing] = useState<boolean | null>(null);

    useEffect(() => {
        setFollowing(null);
        void actions.serverFollowStateAction(hostId).then((state) => setFollowing(state.following));
    }, [hostId]);

    if (following === null) return null;

    const label = following ? "Stop hearing about this server" : "Hear about this server";
    return (
        <Button
            variant="ghost"
            size="sm"
            title={label}
            aria-pressed={following}
            onClick={async () => {
                const next = !following;
                setFollowing(next);
                const result = await actions.setServerFollowAction({ hostId, following: next });
                if (result.error) setFollowing(!next);
            }}
            className={cn(following && "text-primary")}
        >
            {following ? <Bell /> : <BellOff />}
            {following ? "Following" : "Follow"}
        </Button>
    );
}

"use client";

/**
 * The account's activity, narrowed to one session: what was actually done from
 * that device. It is the answer to the question the session list raises but
 * cannot settle on its own - "I do not recognize this, what did it do?" - so it
 * sits next to Sign out rather than in a separate history screen.
 *
 * Entries are read once per open and held briefly, because the list only grows
 * as the user acts elsewhere.
 */

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Skeleton } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import type { SessionActivityEntry } from "@/lib/audit-service";
import type { SessionView } from "@/lib/session-directory";
import { sessionActivityAction } from "./actions";

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; entries: SessionActivityEntry[] }>();

/** "drive.file.uploaded" reads as "Drive file uploaded". */
function label(action: string): string {
    const words = action.replace(/[.\-_]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

export function SessionActivityDialog({
    session,
    onOpenChange
}: {
    session: SessionView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const [entries, setEntries] = useState<SessionActivityEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const sessionId = session?.id ?? null;

    useEffect(() => {
        if (!sessionId) return;
        const cached = cache.get(sessionId);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
            setEntries(cached.entries);
            return;
        }

        let active = true;
        setEntries(null);
        setError(null);
        void sessionActivityAction(sessionId).then((result) => {
            if (!active) return;
            if (result.error || !result.entries) {
                setError(result.error ?? "Could not load this session's activity.");
                return;
            }
            cache.set(sessionId, { at: Date.now(), entries: result.entries });
            setEntries(result.entries);
        });
        return () => {
            active = false;
        };
    }, [sessionId]);

    return (
        <Dialog open={session !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Session activity</DialogTitle>
                    <DialogDescription>
                        What was done from {session?.device ?? "this device"}.
                    </DialogDescription>
                </DialogHeader>

                {error ? <p className="text-sm text-danger">{error}</p> : null}

                {!error && entries === null ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                    </div>
                ) : null}

                {entries !== null && entries.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        Nothing recorded from this session yet.
                    </p>
                ) : null}

                {entries !== null && entries.length > 0 ? (
                    <ul className="-mx-1 max-h-80 overflow-y-auto">
                        {entries.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex items-start justify-between gap-3 border-t border-border px-1 py-2 first:border-t-0"
                            >
                                <div className="flex min-w-0 items-start gap-2">
                                    <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0">
                                        <p className="truncate text-sm">{label(entry.action)}</p>
                                        {entry.target ? (
                                            <p className="truncate text-xs text-muted-foreground">{entry.target}</p>
                                        ) : null}
                                    </div>
                                </div>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    <RelativeTime iso={entry.at} />
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

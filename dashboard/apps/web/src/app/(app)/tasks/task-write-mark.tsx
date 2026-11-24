"use client";

/**
 * How a task row says that what was done to it is still only on this device: a
 * clock while it waits for Polaris, a mark when Polaris did not take it, and
 * one line above the tasks that puts what was not taken back in line or lets
 * it go.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button } from "@polaris/ui";
import { createContext, useContext } from "react";
import { AlertCircle, Clock } from "lucide-react";
import { appWrites, type AppWrite } from "@/lib/offline/app-writes";

// Kept apart from `./offline-writes`, which reaches the server actions: the
// rows that draw the mark are rendered where no server is.

/** Put every task write that was not taken back in line. */
async function retryTaskWrites(entries: readonly AppWrite[]): Promise<void> {
    for (const entry of entries) if (entry.state === "failed") await appWrites.retry(entry);
}

/** Let go of every task write that was not taken: the tasks go back to what Polaris has. */
async function discardTaskWrites(entries: readonly AppWrite[]): Promise<void> {
    for (const entry of entries) if (entry.state === "failed") await appWrites.discard(entry.key);
}

/** Per task, whether a write to it waits on this device or was not taken. */
export const TaskWritesContext = createContext<ReadonlyMap<string, "pending" | "failed">>(new Map());

/** A task's reference, with the clock or the mark beside it when it has one. */
export function TaskReference({ taskId, reference }: { taskId: string; reference: string; }) {
    const t = useTranslations("tasks");
    const state = useContext(TaskWritesContext).get(taskId);
    if (!state) return <>{reference}</>;
    const label = state === "pending" ? t("offline.waiting") : t("offline.notSent");
    return (
        <span className="inline-flex items-center gap-1" title={label}>
            {reference}
            {state === "pending" ? (
                <Clock className="size-3 shrink-0" aria-label={label} />
            ) : (
                <AlertCircle className="size-3 shrink-0 text-danger" aria-label={label} />
            )}
        </span>
    );
}

/** What Polaris did not take, with the reader's two ways out of it. */
export function TaskWritesNotice({ entries }: { entries: readonly AppWrite[]; }) {
    const t = useTranslations("tasks");
    const failed = entries.filter((entry) => entry.state === "failed");
    if (failed.length === 0) return null;
    const reason = failed.find((entry) => entry.reason)?.reason;
    return (
        <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
        >
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
                {t("offline.notSaved", { count: failed.length })}
                {reason ? ` ${reason}` : ""}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void retryTaskWrites(failed)}>
                {t("offline.retry")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void discardTaskWrites(failed)}>
                {t("offline.discard")}
            </Button>
        </div>
    );
}

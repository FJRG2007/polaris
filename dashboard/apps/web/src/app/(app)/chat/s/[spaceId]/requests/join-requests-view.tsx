"use client";

/**
 * Who is asking to join a space, and whether it asks at all.
 *
 * WhatsApp's "Approve new participants": with the switch on, an invitation
 * files a request instead of a seat, and the people waiting are listed here
 * oldest first with Accept and Decline. Only whoever runs the space reaches
 * this page; the server refuses everybody else and the page says so. The switch
 * moves at once and goes back if the server disagrees, and an answered request
 * leaves the list at once and comes back on a refusal.
 */

import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { ArrowLeft, UserPlus } from "lucide-react";
import * as actions from "@/app/(app)/chat/actions";
import { useChat } from "@/app/(app)/chat/chat-context";
import { useCallback, useEffect, useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import type { JoinRequestView } from "@/lib/chat/join-requests";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, EmptyState, Skeleton, Switch } from "@polaris/ui";

interface Queue {
    readonly requireApproval: boolean;
    readonly requests: readonly JoinRequestView[];
}

export function JoinRequestsView({ spaceId }: { spaceId: string }) {
    const t = useTranslations("chat");
    const format = useDisplayFormat();
    const { spaces } = useChat();
    const spaceName = spaces.find((entry) => entry.id === spaceId)?.name ?? null;
    const [queue, setQueue] = useState<Queue | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [answering, setAnswering] = useState<string | null>(null);

    const load = useCallback(() => {
        void actions.joinRequestsAction(spaceId).then((answer) => {
            if (answer.queue) {
                setQueue(answer.queue);
                setFailed(null);
            } else setFailed(answer.error ?? t("errors.notDone"));
        });
    }, [spaceId, t]);
    useEffect(load, [load]);

    const setAsking = async (on: boolean) => {
        if (!queue) return;
        const before = queue;
        setError("");
        setQueue({ ...queue, requireApproval: on });
        const result = await runAction(
            () => actions.setRequireApprovalAction({ spaceId, on }),
            setError
        );
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            setQueue(before);
        }
    };

    const answer = async (request: JoinRequestView, accept: boolean) => {
        if (!queue) return;
        const before = queue;
        setError("");
        setAnswering(request.id);
        setQueue({ ...queue, requests: queue.requests.filter((row) => row.id !== request.id) });
        const result = await runAction(
            () => actions.answerJoinRequestAction({ requestId: request.id, accept }),
            setError
        );
        setAnswering(null);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            setQueue(before);
        }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Link
                    data-swipe-back
                    href="/chat"
                    aria-label={t("joinRequests.back")}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <UserPlus className="size-4 shrink-0 text-primary" />
                <span
                    className="min-w-0 max-w-full shrink-0 truncate text-sm font-semibold"
                    title={t("joinRequests.title")}
                >
                    {t("joinRequests.title")}
                </span>
                {spaceName && (
                    <span className="min-w-0 truncate text-sm text-muted-foreground" title={spaceName}>
                        {spaceName}
                    </span>
                )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
                    {failed && (
                        <p
                            className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground"
                            role="alert"
                        >
                            {failed}
                        </p>
                    )}
                    {error && (
                        <p className="text-sm text-danger" role="alert">
                            {error}
                        </p>
                    )}

                    {queue === null && !failed ? (
                        <Skeleton className="h-16 w-full" />
                    ) : queue ? (
                        <label className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3">
                            <span className="flex min-w-0 flex-col">
                                <span className="text-sm font-medium">{t("joinRequests.ask")}</span>
                                <span className="text-xs text-muted-foreground">
                                    {t("joinRequests.askHint")}
                                </span>
                            </span>
                            <Switch
                                checked={queue.requireApproval}
                                onChange={(on: boolean) => void setAsking(on)}
                                aria-label={t("joinRequests.ask")}
                            />
                        </label>
                    ) : null}

                    <section className="flex flex-col gap-2">
                        <h2 className="text-sm font-medium">{t("joinRequests.waiting")}</h2>
                        {queue === null && !failed ? (
                            <Skeleton className="h-24 w-full" />
                        ) : queue && queue.requests.length === 0 ? (
                            <EmptyState
                                icon={<UserPlus className="size-5" />}
                                title={t("joinRequests.empty")}
                                description={t("joinRequests.emptyHint")}
                            />
                        ) : queue ? (
                            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                                {queue.requests.map((request) => (
                                    <li
                                        key={request.id}
                                        className="flex flex-wrap items-center gap-3 px-3 py-2"
                                    >
                                        <Avatar person={{ id: request.userId, name: request.name }} size={32} />
                                        <span className="flex min-w-0 flex-1 flex-col">
                                            {request.username ? (
                                                <Link
                                                    href={`/u/${request.username}`}
                                                    className="truncate text-sm font-medium hover:underline"
                                                    title={request.name}
                                                >
                                                    {request.name}
                                                </Link>
                                            ) : (
                                                <span className="truncate text-sm font-medium" title={request.name}>
                                                    {request.name}
                                                </span>
                                            )}
                                            <span className="text-xs text-muted-foreground">
                                                {t("joinRequests.askedAt", {
                                                    time: format.dateTime(request.createdAt)
                                                })}
                                            </span>
                                        </span>
                                        <span className="flex shrink-0 gap-2">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={answering !== null}
                                                onClick={() => void answer(request, false)}
                                            >
                                                {t("joinRequests.decline")}
                                            </Button>
                                            <Button
                                                size="sm"
                                                disabled={answering !== null}
                                                onClick={() => void answer(request, true)}
                                            >
                                                {t("joinRequests.accept")}
                                            </Button>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </section>
                </div>
            </div>
        </div>
    );
}

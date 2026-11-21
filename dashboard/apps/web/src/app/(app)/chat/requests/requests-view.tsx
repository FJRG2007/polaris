"use client";

/**
 * Message requests waiting on this reader, each with Delete, Block and Accept.
 *
 * Reading a request here sends no read receipt - the list is drawn from a
 * preview, not by opening the conversation. Answering takes the row off at once
 * and puts it back if the server refuses; a request the server says is gone
 * stays gone, since there is nothing left to answer.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Inbox } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, EmptyState, Skeleton, useToast } from "@polaris/ui";
import type { MessageRequestView } from "@/lib/chat/message-requests";
import { answerMessageRequestAction, listMessageRequestsAction } from "../actions";

type Answer = "accept" | "delete" | "block";

export function RequestsView() {
    const t = useTranslations("chat");
    const toast = useToast();
    const router = useRouter();
    const [requests, setRequests] = useState<MessageRequestView[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(() => {
        setFailed(false);
        listMessageRequestsAction().then(
            (result) => setRequests(result.requests),
            () => setFailed(true)
        );
    }, []);
    useEffect(load, [load]);

    const answer = async (request: MessageRequestView, choice: Answer) => {
        if (busy) return;
        setBusy(request.channelId);
        const before = requests;
        setRequests((current) => current?.filter((row) => row.channelId !== request.channelId) ?? null);
        const key = `message-request-${request.channelId}`;
        try {
            const result = await answerMessageRequestAction({ channelId: request.channelId, answer: choice });
            if (result.channelId) {
                router.push(`/chat/c/${result.channelId}`);
                return;
            }
            if (result.error) {
                toast.show({ key, title: result.error });
                if (result.error !== t("errors.messageRequestGone")) setRequests(before);
                return;
            }
            if (choice === "block") toast.show({ key, title: t("messageRequests.blocked", { name: request.senderName }) });
        } catch {
            toast.show({ key, title: t("messageRequests.failed") });
            setRequests(before);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
            <div className="flex min-w-0 items-center gap-2">
                <Button size="sm" variant="ghost" asChild>
                    <Link href="/chat" aria-label={t("messageRequests.back")}>
                        <ArrowLeft className="size-4 shrink-0" />
                    </Link>
                </Button>
                <h1 className="min-w-0 truncate text-[1.0625rem] font-semibold tracking-tight">
                    {t("messageRequests.title")}
                </h1>
            </div>
            {failed ? (
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                    <span className="min-w-0 flex-1">{t("messageRequests.loadFailed")}</span>
                    <Button size="sm" variant="secondary" onClick={load}>
                        {t("messageRequests.retry")}
                    </Button>
                </div>
            ) : requests === null ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                    {[0, 1, 2].map((row) => (
                        <Skeleton key={row} className="h-16 w-full" />
                    ))}
                </div>
            ) : requests.length === 0 ? (
                <EmptyState
                    icon={<Inbox />}
                    title={t("messageRequests.empty")}
                    description={t("messageRequests.emptyHint")}
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                    {requests.map((request) => (
                        <li
                            key={request.channelId}
                            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
                        >
                            <span className="min-w-0 flex-1">
                                <span className="flex min-w-0 items-baseline gap-2">
                                    {request.senderUsername ? (
                                        <Link
                                            href={`/u/${request.senderUsername}`}
                                            className="min-w-0 truncate text-[0.8125rem] hover:underline"
                                            title={request.senderName}
                                        >
                                            {request.senderName}
                                        </Link>
                                    ) : (
                                        <span
                                            className="min-w-0 truncate text-[0.8125rem]"
                                            title={request.senderName}
                                        >
                                            {request.senderName}
                                        </span>
                                    )}
                                    <span className="shrink-0 text-[0.6875rem] text-foreground-subtle">
                                        {t("messageRequests.waiting", { count: request.waiting })}
                                    </span>
                                </span>
                                <span
                                    className="block truncate text-[0.6875rem] text-foreground-subtle"
                                    title={request.preview}
                                >
                                    {request.preview || t("messageRequests.noPreview")}
                                </span>
                            </span>
                            <span className="flex shrink-0 gap-2">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy !== null}
                                    onClick={() => void answer(request, "block")}
                                >
                                    {t("messageRequests.block")}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy !== null}
                                    onClick={() => void answer(request, "delete")}
                                >
                                    {t("messageRequests.delete")}
                                </Button>
                                <Button
                                    size="sm"
                                    disabled={busy !== null}
                                    onClick={() => void answer(request, "accept")}
                                >
                                    {t("messageRequests.accept")}
                                </Button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

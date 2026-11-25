"use client";

/**
 * Who picked each answer of a poll that was asked in public.
 *
 * The list Telegram calls "view votes" on a public poll: every answer, with the
 * people who picked it under it. Only ever opened from a public poll whose
 * counts are already showing - the server refuses the read for an anonymous
 * one, and for a hidden one still running, so this dialog is never the thing
 * standing between a voter and their answer being known.
 *
 * The words of each answer come from the card rather than the server, because a
 * sealed poll's answers are only words in the browser that opened its seal.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { PersonName, PersonRow } from "@/components/person-name";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ChatPollView, ChatPollVotersView } from "@/lib/chat/polls";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

export function PollVotersDialog({
    messageId,
    poll,
    onOpenChange
}: {
    messageId: string;
    poll: ChatPollView;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("chat");
    const [answers, setAnswers] = useState<readonly ChatPollVotersView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let live = true;
        setAnswers(null);
        setError(null);
        void actions
            .pollVotersAction(messageId)
            .then((result) => {
                if (!live) return;
                if (result.answers) setAnswers(result.answers);
                else setError(result.error ?? t("pollCard.votersNotLoaded"));
            })
            .catch(() => live && setError(t("pollCard.votersNotLoaded")));
        return () => {
            live = false;
        };
    }, [messageId, attempt, t]);

    const byId = new Map(answers?.map((answer) => [answer.optionId, answer]));

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="gap-4">
                <DialogHeader>
                    <DialogTitle>{t("pollCard.whoVoted")}</DialogTitle>
                    <DialogDescription>{t("pollCard.whoVotedDescription")}</DialogDescription>
                </DialogHeader>

                <div className="flex max-h-96 flex-col gap-4 overflow-y-auto overscroll-contain">
                    {poll.options.map((option) => {
                        const answer = byId.get(option.id);
                        return (
                            <section key={option.id} className="flex min-w-0 flex-col gap-1">
                                <h3 className="flex min-w-0 items-baseline gap-2 text-sm font-medium">
                                    <span className="min-w-0 flex-1 break-words">{option.text}</span>
                                    {answer && (
                                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                            {t("pollCard.votes", { count: answer.voters.length + answer.more })}
                                        </span>
                                    )}
                                </h3>
                                {answers === null && error === null ? (
                                    <div className="flex items-center gap-2 px-2 py-1" aria-hidden="true">
                                        <Skeleton className="size-6 rounded-full" />
                                        <Skeleton className="h-3 w-32" />
                                    </div>
                                ) : answer && answer.voters.length > 0 ? (
                                    <ul className="flex flex-col">
                                        {answer.voters.map((voter) => (
                                            <PersonRow
                                                as="li"
                                                key={voter.id}
                                                personId={voter.id}
                                                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1"
                                            >
                                                <Avatar person={{ id: voter.id, name: voter.name }} size={24} />
                                                <span className="min-w-0 flex-1 truncate text-sm" title={voter.name}>
                                                    <PersonName id={voter.id} name={voter.name} />
                                                </span>
                                            </PersonRow>
                                        ))}
                                        {answer.more > 0 && (
                                            <li className="px-2 py-1 text-xs text-muted-foreground">
                                                {t("pollCard.andMore", { count: answer.more })}
                                            </li>
                                        )}
                                    </ul>
                                ) : answer ? (
                                    <p className="px-2 text-xs text-muted-foreground">{t("pollCard.nobodyPickedThis")}</p>
                                ) : null}
                            </section>
                        );
                    })}
                </div>

                {error && (
                    <div className="flex items-center gap-2">
                        <p role="alert" className="min-w-0 flex-1 text-sm text-danger">
                            {error}
                        </p>
                        <Button size="xs" variant="secondary" onClick={() => setAttempt((count) => count + 1)}>
                            {t("pollCard.tryAgain")}
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

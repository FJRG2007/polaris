"use client";

/**
 * Which occurrences of a repeating event a change reaches: this one, this and
 * the ones after it, or all of them. Asked in a dialog, as a promise, so a
 * caller keeps its flow: `const scope = await ask({ action: "delete" })`.
 * Closing the dialog answers null, and the caller does nothing.
 */

import { useCalendarT } from "./i18n";
import type { EditScope } from "../engine";
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export interface ScopeQuestion {
    readonly action: "save" | "delete" | "move";
    /** False when "only this one" cannot apply - the rule itself changed. */
    readonly allowThis?: boolean;
}

export function ScopeDialog({
    question,
    onAnswer
}: {
    question: ScopeQuestion | null;
    onAnswer: (scope: EditScope | null) => void;
}) {
    const t = useCalendarT();
    const action = question?.action ?? "save";
    const choices: EditScope[] =
        question?.allowThis === false ? ["following", "all"] : ["this", "following", "all"];
    return (
        <Dialog open={question !== null} onOpenChange={(open) => !open && onAnswer(null)}>
            <DialogContent className="max-w-sm">
                <DialogHeader className="pr-8">
                    <DialogTitle>{t(`scope.title.${action}`)}</DialogTitle>
                    <DialogDescription>{t("scope.description")}</DialogDescription>
                </DialogHeader>
                <div
                    role="group"
                    aria-label={t(`scope.title.${action}`)}
                    className="flex flex-col gap-2"
                >
                    {choices.map((scope) => (
                        <Button
                            key={scope}
                            variant={
                                scope === "this" ||
                                (scope === "following" && !choices.includes("this"))
                                    ? "primary"
                                    : "outline"
                            }
                            className="justify-start"
                            onClick={() => onAnswer(scope)}
                        >
                            {t(`scope.choice.${scope}`)}
                        </Button>
                    ))}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onAnswer(null)}>
                        {t("screen.cancel")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The dialog as a promise: `[ask, element]`, element mounted once. */
export function useScopeChoice(): [
    (question: ScopeQuestion) => Promise<EditScope | null>,
    ReactNode
] {
    const [question, setQuestion] = useState<ScopeQuestion | null>(null);
    const resolver = useRef<((scope: EditScope | null) => void) | null>(null);
    const ask = useCallback(
        (next: ScopeQuestion) =>
            new Promise<EditScope | null>((resolve) => {
                resolver.current?.(null);
                resolver.current = resolve;
                setQuestion(next);
            }),
        []
    );
    const answer = useCallback((scope: EditScope | null) => {
        resolver.current?.(scope);
        resolver.current = null;
        setQuestion(null);
    }, []);
    return [ask, <ScopeDialog key="scope" question={question} onAnswer={answer} />];
}

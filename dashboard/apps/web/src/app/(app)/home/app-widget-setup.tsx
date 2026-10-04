"use client";

/**
 * Choosing what an app's card watches.
 *
 * The app lists what this reader may pick - the devices they can see, say - and
 * the reader ticks the ones the card should show. Used for a new card and for
 * changing one already on the Overview.
 */

import { useEffect, useState } from "react";
import { MAX_APP_WIDGET_TARGETS } from "@polaris/core";
import { appWidgetTargetsAction } from "./app-widget-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AppWidgetTarget } from "@/lib/app-extensions/types";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

export interface AppWidgetSetupSubject {
    readonly app: string;
    readonly kind: string;
    readonly label: string;
    /** What it watches now, for a card that is already on the Overview. */
    readonly targets: readonly string[];
}

export function AppWidgetSetup({
    subject,
    onCancel,
    onSave
}: {
    /** The card being set up, or null when the dialog is closed. */
    subject: AppWidgetSetupSubject | null;
    onCancel: () => void;
    onSave: (targets: string[]) => void;
}) {
    const t = useTranslations("home");
    const [targets, setTargets] = useState<AppWidgetTarget[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [chosen, setChosen] = useState<string[]>([]);

    const key = subject ? `${subject.app}:${subject.kind}` : "";
    useEffect(() => {
        if (!subject) return;
        let live = true;
        setTargets(null);
        setProblem(null);
        setChosen([...subject.targets]);
        void appWidgetTargetsAction(subject.app, subject.kind).then(
            (answer) => {
                if (!live) return;
                if (answer.error) setProblem(answer.error);
                setTargets(answer.targets ?? []);
            },
            () => {
                if (live) setProblem(t("appCards.readFailed"));
            }
        );
        return () => {
            live = false;
        };
        // Asked again for a different card, not for a re-render of the same one.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const full = chosen.length >= MAX_APP_WIDGET_TARGETS;
    const toggle = (id: string) =>
        setChosen((current) =>
            current.includes(id)
                ? current.filter((one) => one !== id)
                : current.length >= MAX_APP_WIDGET_TARGETS
                  ? current
                  : [...current, id]
        );

    return (
        <Dialog open={subject !== null} onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("appCards.setupTitle", { name: subject?.label ?? "" })}</DialogTitle>
                    <DialogDescription>
                        {t("appCards.setupHint", { count: MAX_APP_WIDGET_TARGETS })}
                    </DialogDescription>
                </DialogHeader>
                {targets === null && !problem ? (
                    <div className="flex flex-col gap-2" aria-busy="true">
                        {[0, 1, 2].map((row) => (
                            <Skeleton key={row} className="h-8 w-full" />
                        ))}
                    </div>
                ) : problem ? (
                    <p role="alert" className="text-sm text-danger">
                        {problem}
                    </p>
                ) : targets && targets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("appCards.nothingToPick")}</p>
                ) : (
                    <ul className="-mx-1 flex max-h-[min(50vh,22rem)] flex-col overflow-y-auto overscroll-contain px-1">
                        {(targets ?? []).map((target) => {
                            const on = chosen.includes(target.id);
                            return (
                                <li key={target.id}>
                                    <label className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
                                        <Checkbox
                                            checked={on}
                                            disabled={!on && full}
                                            onChange={() => toggle(target.id)}
                                        />
                                        <span className="flex min-w-0 flex-col">
                                            <span className="truncate text-sm" title={target.label}>
                                                {target.label}
                                            </span>
                                            {target.detail ? (
                                                <span
                                                    className="truncate text-xs text-muted-foreground"
                                                    title={target.detail}
                                                >
                                                    {target.detail}
                                                </span>
                                            ) : null}
                                        </span>
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={onCancel}>
                        {t("appCards.cancel")}
                    </Button>
                    <Button disabled={chosen.length === 0} onClick={() => onSave(chosen)}>
                        {t("appCards.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

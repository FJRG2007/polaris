"use client";

/**
 * Start protecting something.
 *
 * It offers what is actually here rather than asking somebody to describe it:
 * the databases Polaris runs, the game servers, the service volumes. Typing an
 * id is how you protect the wrong thing.
 *
 * The list is loaded when the dialog opens, not with the console - enumerating
 * every source costs several queries and a round trip into each game server, and
 * nobody waiting for the table should pay for it.
 */

import { protectAction } from "./actions";
import { readJson } from "@/lib/read-json";
import { useEffect, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import type { DestinationSummary, DiscoveredCandidate, PlanSummary } from "./types";
import { kindLabel, kindSummary } from "@/lib/backups/words";
import { readReasonText } from "@/lib/read-json";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Select,
    Skeleton
} from "@polaris/ui";

export function ProtectDialog({
    plans,
    destinations,
    onClose,
    onProtected
}: {
    plans: PlanSummary[];
    destinations: DestinationSummary[];
    onClose: () => void;
    onProtected: () => Promise<void>;
}) {
    const t = useTranslations("backups");
    const tc = useTranslations("components");
    const tcommon = useTranslations("common");
    const [candidates, setCandidates] = useState<DiscoveredCandidate[] | null>(null);
    const [chosen, setChosen] = useState<string[]>([]);
    const [planId, setPlanId] = useState<string>("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        void readJson<{ candidates: DiscoveredCandidate[] }>("/api/backups/discover").then(
            (data) => {
                if (!live) return;
                // "Everything is already protected" is a claim, and a read that failed
                // cannot make it - so the reason goes where the list would have been.
                setCandidates(data.ok ? data.value.candidates : []);
                if (!data.ok) setError(readReasonText(tc, data.reason));
            }
        );
        return () => {
            live = false;
        };
    }, [tc]);

    async function onSave() {
        setPending(true);
        setError(null);
        const picked = (candidates ?? []).filter((candidate) =>
            chosen.includes(candidate.selector)
        );
        for (const candidate of picked) {
            const result = await protectAction({
                target: candidate.target,
                name: candidate.name,
                planId: planId || null
            });
            if (result.error) {
                setError(t("destinations.testFailed", { name: candidate.name, reason: result.error }));
                setPending(false);
                return;
            }
        }
        setPending(false);
        await onProtected();
        onClose();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <ShieldCheck className="size-5 text-primary" />
                        {t("table.add")}
                    </DialogTitle>
                    <DialogDescription>{t("protect.intro")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    {destinations.length === 0 ? (
                        <p className="rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-warning-ink">
                            {t("protect.noDestination")}
                        </p>
                    ) : null}

                    <div className="max-h-72 overflow-y-auto overscroll-contain rounded-md border border-border">
                        {candidates === null ? (
                            <div className="flex flex-col gap-2 p-3">
                                {Array.from({ length: 3 }, (_, index) => (
                                    <Skeleton key={index} className="h-10 w-full" />
                                ))}
                            </div>
                        ) : candidates.length === 0 ? (
                            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                {t("protect.allProtected")}
                            </p>
                        ) : (
                            <ul className="divide-y divide-border">
                                {candidates.map((candidate) => (
                                    <li key={candidate.selector}>
                                        <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-muted/40">
                                            <input
                                                type="checkbox"
                                                className="mt-1"
                                                checked={chosen.includes(candidate.selector)}
                                                onChange={(event) =>
                                                    setChosen((current) =>
                                                        event.target.checked
                                                            ? [...current, candidate.selector]
                                                            : current.filter(
                                                                  (entry) =>
                                                                      entry !== candidate.selector
                                                              )
                                                    )
                                                }
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="flex items-center gap-2 text-sm font-medium">
                                                    {candidate.name}
                                                    <span className="text-xs font-normal text-muted-foreground">
                                                        {kindLabel(t, candidate.kind, candidate.kindLabel)}
                                                    </span>
                                                </span>
                                                <span className="block truncate text-xs text-muted-foreground">
                                                    {candidate.context ?? kindSummary(t, candidate.kind, candidate.summary)}
                                                </span>
                                            </span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("table.columns.plan")}</span>
                        <Select
                            value={planId}
                            onValueChange={setPlanId}
                            aria-label={t("table.columns.plan")}
                            options={[
                                { value: "", label: t("table.onDemandOnly") },
                                ...plans.map((plan) => ({ value: plan.id, label: plan.name }))
                            ]}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("protect.planHint")}
                        </span>
                    </label>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button variant="ghost">{tcommon("actions.cancel")}</Button>
                        </DialogClose>
                        <Button
                            onClick={() => void onSave()}
                            disabled={pending || chosen.length === 0}
                        >
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            {chosen.length > 1 ? t("protect.many", { count: chosen.length }) : t("protect.one")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

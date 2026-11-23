"use client";

/**
 * The one-time offer to give the environments made before private networking a
 * network of their own (see `lib/deploy/network-isolation.ts`). Lists every
 * environment it would change and what in it starts again; nothing restarts
 * until the confirm dialog says so.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Network } from "lucide-react";
import { useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { IsolationReview } from "@/lib/deploy/network-isolation";
import { applyNetworkIsolationAction, keepNetworksAction } from "./network-isolation-actions";
import {
    Button,
    Card,
    CardBody,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function NetworkIsolationCard({
    review,
    canManage
}: {
    review: IsolationReview;
    canManage: boolean;
}) {
    const t = useTranslations("deploySafety");
    const router = useRouter();
    const [chosen, setChosen] = useState<ReadonlySet<string>>(
        () => new Set(review.environments.map((environment) => environment.id))
    );
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    if (review.settledAt || review.environments.length === 0) {
        return done ? (
            <p role="status" className="text-sm text-muted-foreground">
                {done}
            </p>
        ) : null;
    }

    const picked = review.environments.filter((environment) => chosen.has(environment.id));
    const restarts = picked.reduce(
        (sum, environment) => sum + environment.restarts.length + environment.moreRestarts,
        0
    );
    const locked = !canManage || !review.capable;

    function toggle(id: string, on: boolean): void {
        setChosen((previous) => {
            const next = new Set(previous);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });
    }

    function apply(): void {
        setError(null);
        startTransition(async () => {
            const result = await applyNetworkIsolationAction({
                environmentIds: picked.map((environment) => environment.id)
            }).catch(() => ({ error: t("isolation.failed") }));
            if (result.error) {
                setError(result.error);
                return;
            }
            setConfirming(false);
            const restarting = "restarting" in result ? (result.restarting ?? 0) : 0;
            setDone(
                restarting > 0
                    ? t("isolation.started", { count: restarting })
                    : t("isolation.isolatedOnly")
            );
            router.refresh();
        });
    }

    function keep(): void {
        setError(null);
        startTransition(async () => {
            const result = await keepNetworksAction().catch(() => ({ error: t("isolation.failed") }));
            if (result.error) {
                setError(result.error);
                return;
            }
            setDone(t("isolation.kept"));
            router.refresh();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="flex items-center gap-2 text-sm font-medium">
                        <Network className="size-4 shrink-0 text-muted-foreground" />
                        {t("isolation.title")}
                    </h2>
                    <p className="text-sm text-muted-foreground">{t("isolation.intro")}</p>
                </div>
                {!review.capable && (
                    <p className="text-sm text-warning">{t("isolation.needsUpdate")}</p>
                )}
                <ul className="flex flex-col divide-y divide-border/40 rounded-md border border-border/60">
                    {review.environments.map((environment) => {
                        const label = `${environment.projectName} / ${environment.name}`;
                        const names = environment.restarts.join(", ");
                        return (
                            <li key={environment.id} className="flex min-w-0 items-start gap-3 px-3 py-2.5">
                                <Checkbox
                                    className="mt-0.5"
                                    checked={chosen.has(environment.id)}
                                    disabled={locked || pending}
                                    aria-label={t("isolation.include", { name: label })}
                                    onChange={(event) => toggle(environment.id, event.target.checked)}
                                />
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <Link
                                        href={`/apps/deploy/${environment.projectId}`}
                                        className="truncate text-sm font-medium hover:underline"
                                        title={label}
                                    >
                                        {label}
                                    </Link>
                                    <p className="text-xs text-muted-foreground">
                                        {environment.change === "isolate"
                                            ? t("isolation.changeIsolate")
                                            : t("isolation.changeRestart")}
                                    </p>
                                    <p className="break-words text-xs text-muted-foreground">
                                        {environment.restarts.length === 0
                                            ? t("isolation.nothingRuns")
                                            : environment.moreRestarts > 0
                                              ? t("isolation.restartsMore", {
                                                    names,
                                                    count: environment.moreRestarts
                                                })
                                              : t("isolation.restarts", { names })}
                                    </p>
                                </div>
                            </li>
                        );
                    })}
                </ul>
                {review.truncated && (
                    <p className="text-xs text-muted-foreground">{t("isolation.truncated")}</p>
                )}
                {!confirming && error && (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error}
                    </p>
                )}
                {canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            disabled={locked || pending || picked.length === 0}
                            onClick={() => {
                                setError(null);
                                setConfirming(true);
                            }}
                        >
                            {t("isolation.apply")}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={pending} onClick={keep}>
                            {pending && !confirming && <Loader2 className="size-3.5 animate-spin" />}
                            {t("isolation.keep")}
                        </Button>
                    </div>
                )}
            </CardBody>
            {confirming && (
                <Dialog open onOpenChange={(next) => !next && !pending && setConfirming(false)}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>{t("isolation.confirmTitle")}</DialogTitle>
                            <DialogDescription>
                                {t("isolation.confirmBody", { environments: picked.length, count: restarts })}
                            </DialogDescription>
                        </DialogHeader>
                        {error && (
                            <p role="alert" className="text-sm text-danger-ink">
                                {error}
                            </p>
                        )}
                        <DialogFooter>
                            <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                                {t("isolation.cancel")}
                            </Button>
                            <Button disabled={pending} onClick={apply}>
                                {pending ? <Loader2 className="size-4 animate-spin" /> : t("isolation.confirm")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )}
        </Card>
    );
}

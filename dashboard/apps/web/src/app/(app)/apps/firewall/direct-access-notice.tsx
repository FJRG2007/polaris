"use client";

/**
 * What a scope's firewall does not cover: a service the edge answers for that still
 * answers on a host port, where the login, the address lists and the rules are
 * nowhere in the way. Said on the scope itself, naming each service and its
 * address, with the button that moves those services to the edge alone - so the
 * screen never claims a protection that a direct address walks round.
 *
 * Renders nothing until it knows, and nothing when there is nothing to say: the
 * rules around it never wait on it.
 */

import { AlertTriangle } from "lucide-react";
import type { WafScopeType } from "@polaris/core";
import { useCallback, useEffect, useState } from "react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    useToast
} from "@polaris/ui";
import type { DirectAccess } from "@/lib/deploy/direct-port";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { closeDirectAccessAction, getDirectAccessAction } from "./actions";

/** Which port the confirmation is for: one service's, or every one listed. */
type Asking = { readonly kind: "one"; readonly entry: DirectAccess } | { readonly kind: "all" };

export function DirectAccessNotice({
    scopeType,
    scopeId,
    canClose
}: {
    scopeType: WafScopeType;
    scopeId: string;
    /** The reader may close these: the same check the close action enforces. */
    canClose: boolean;
}) {
    const t = useTranslations("firewall");
    const common = useTranslations("common");
    const toast = useToast();
    const [reachable, setReachable] = useState<readonly DirectAccess[]>([]);
    // Ports asked to close: each stays listed until its new release is serving,
    // which is when the port is really gone, and reads as closing until then.
    const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
    const [asking, setAsking] = useState<Asking | null>(null);
    const [sending, setSending] = useState(false);

    const fetchReachable = useCallback(
        () =>
            getDirectAccessAction({ scopeType, scopeId })
                .then((result) => result.reachable ?? null)
                .catch(() => null),
        [scopeType, scopeId]
    );

    const load = useCallback(async () => {
        const next = await fetchReachable();
        if (next) setReachable(next);
    }, [fetchReachable]);

    useEffect(() => {
        let live = true;
        setReachable([]);
        setClosing(new Set());
        void fetchReachable().then((next) => {
            if (live && next) setReachable(next);
        });
        return () => {
            live = false;
        };
    }, [fetchReachable]);

    if (reachable.length === 0) return null;
    const isClosing = (entry: DirectAccess) => entry.closing || closing.has(entry.applicationId);
    const open = reachable.filter((entry) => entry.held === null && !isClosing(entry));

    const confirm = async () => {
        if (!asking) return;
        const ids =
            asking.kind === "one" ? [asking.entry.applicationId] : open.map((entry) => entry.applicationId);
        const before = closing;
        // Optimistic: the rows read as closing at once, and go back if it fails.
        setClosing(new Set([...before, ...ids]));
        setSending(true);
        const result = await closeDirectAccessAction({
            scopeType,
            scopeId,
            ...(asking.kind === "one" ? { applicationId: asking.entry.applicationId } : {})
        }).catch(() => ({ error: t("direct.closeFailed") }) as const);
        setSending(false);
        setAsking(null);
        if ("error" in result && result.error) {
            setClosing(before);
            toast.show({ title: result.error });
            return;
        }
        const failedIds = "failedIds" in result ? (result.failedIds ?? []) : [];
        if (failedIds.length > 0) {
            setClosing((current) => new Set([...current].filter((id) => !failedIds.includes(id))));
        }
        toast.show({
            title: "failed" in result && result.failed ? t("direct.closeFailed") : t("direct.closing")
        });
        void load();
    };

    const count = asking?.kind === "one" ? 1 : open.length;

    return (
        <section
            aria-labelledby="direct-access-title"
            className="flex flex-col gap-3 rounded-md border border-warning-edge bg-warning-soft p-3 text-sm"
        >
            <div className="flex min-w-0 items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden="true" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h2 id="direct-access-title" className="font-medium text-warning-ink">
                        {t("direct.title")}
                    </h2>
                    <p className="text-muted-foreground">{t("direct.description")}</p>
                </div>
                {canClose && open.length > 1 ? (
                    <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setAsking({ kind: "all" })}
                    >
                        {t("direct.closeAll")}
                    </Button>
                ) : null}
            </div>
            <ul className="flex min-w-0 flex-col divide-y divide-warning-edge">
                {reachable.map((entry) => {
                    const pending = isClosing(entry);
                    const label = t("direct.service", { name: entry.name, address: entry.address });
                    return (
                        <li
                            key={entry.applicationId}
                            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2"
                        >
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="min-w-0 truncate font-medium" title={label}>
                                    {label}
                                </span>
                                {entry.held ? (
                                    <span className="text-xs text-muted-foreground">
                                        {entry.held === "keptRelease"
                                            ? t("direct.keptRelease")
                                            : t("direct.installed")}
                                    </span>
                                ) : null}
                            </div>
                            {pending ? (
                                <Badge variant="warning">{t("direct.closingBadge")}</Badge>
                            ) : entry.held === null ? (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!canClose}
                                    title={canClose ? t("direct.closeNamed", { name: entry.name }) : t("direct.noPermission")}
                                    aria-label={t("direct.closeNamed", { name: entry.name })}
                                    onClick={() => setAsking({ kind: "one", entry })}
                                >
                                    {t("direct.close")}
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
            {!canClose ? <p className="text-xs text-muted-foreground">{t("direct.noPermission")}</p> : null}
            <Dialog open={asking !== null} onOpenChange={(next) => (!next && !sending ? setAsking(null) : undefined)}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("direct.confirmTitle", { count })}</DialogTitle>
                        <DialogDescription>{t("direct.confirmBody")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" disabled={sending} onClick={() => setAsking(null)}>
                            {common("actions.cancel")}
                        </Button>
                        <Button variant="danger" disabled={sending} onClick={() => void confirm()}>
                            {t("direct.confirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}

"use client";

/**
 * The host firewall on one server: its state in a line, and the review that
 * shows what turning it on leaves open and closes before anything changes,
 * with a switch per closing port to keep it open.
 */

import { useEffect, useState } from "react";
import { ErrorLine } from "./error-line";
import * as actions from "../actions/security";
import type { SecurityTranslator } from "../lib/i18n";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Skeleton,
    Switch
} from "@polaris/ui";

type Submit = (
    work: () => Promise<{ ok: boolean; error?: string }>,
    done?: string
) => Promise<void>;

type View = Extract<Awaited<ReturnType<typeof actions.firewallAction>>, { ok: true }>["data"];

export interface FirewallSummary {
    readonly firewall: string;
    readonly firewallClosing: number | null;
    readonly firewallOffByHandAt: string | null;
}

/** `tcp:22` as a reader writes it. */
function portLabel(word: string): string {
    const [proto = "", port = ""] = word.split(":");
    return `${port}/${proto.toUpperCase()}`;
}

function hintOf(t: SecurityTranslator, summary: FirewallSummary): string {
    switch (summary.firewall) {
        case "on":
            return t("firewall.hint.on");
        case "armed":
            return t("firewall.hint.armed");
        case "router":
            return t("firewall.hint.router");
        case "off":
            if (summary.firewallOffByHandAt) {
                return t("firewall.hint.offByHand", {
                    when: new Date(summary.firewallOffByHandAt).toLocaleString()
                });
            }
            return summary.firewallClosing
                ? t("firewall.hint.offCount", { count: summary.firewallClosing })
                : t("firewall.hint.off");
        default:
            return t("firewall.hint.unknown");
    }
}

export function FirewallPanel({
    t,
    targetId,
    summary,
    submit,
    review = false
}: {
    t: SecurityTranslator;
    targetId: string;
    summary: FirewallSummary;
    submit: Submit;
    /** Opened from an alert about this: the review starts open. */
    review?: boolean;
}) {
    const [shown, setShown] = useState(summary);
    const [reviewing, setReviewing] = useState(review);
    const [busy, setBusy] = useState(false);
    useEffect(() => setShown(summary), [summary]);
    const turnOff = async () => {
        const previous = shown;
        setBusy(true);
        setShown({ ...shown, firewall: "off", firewallOffByHandAt: new Date().toISOString() });
        await submit(async () => {
            const result = await actions.firewallOffAction({ targetId });
            if (!result.ok) setShown(previous);
            return result;
        }, t("firewall.offDone"));
        setBusy(false);
    };
    return (
        <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                    <span className="flex items-center gap-2 font-medium">
                        {t("firewall.title")}
                        {shown.firewall === "on" ? (
                            <Badge variant="success">{t("firewall.on")}</Badge>
                        ) : null}
                    </span>
                    <span className="text-muted-foreground">{hintOf(t, shown)}</span>
                </span>
                {shown.firewall === "router" ? null : (
                    <span className="flex shrink-0 flex-wrap gap-2">
                        {shown.firewall === "on" ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void turnOff()}
                            >
                                {t("firewall.turnOff")}
                            </Button>
                        ) : null}
                        <Button
                            size="sm"
                            variant={shown.firewall === "on" ? "outline" : "primary"}
                            disabled={busy || shown.firewall === "armed"}
                            onClick={() => setReviewing(true)}
                        >
                            {shown.firewall === "on" ? t("firewall.review") : t("firewall.turnOn")}
                        </Button>
                    </span>
                )}
            </div>
            {reviewing ? (
                <ReviewDialog
                    t={t}
                    targetId={targetId}
                    onClose={() => setReviewing(false)}
                    onApplied={(view) =>
                        setShown({
                            firewall: view.state,
                            firewallClosing: view.plan.closing.length,
                            firewallOffByHandAt: null
                        })
                    }
                    submit={submit}
                />
            ) : null}
        </div>
    );
}

function ReviewDialog({
    t,
    targetId,
    onClose,
    onApplied,
    submit
}: {
    t: SecurityTranslator;
    targetId: string;
    onClose: () => void;
    onApplied: (view: View) => void;
    submit: Submit;
}) {
    const [view, setView] = useState<View | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
    const [applying, setApplying] = useState(false);
    useEffect(() => {
        let live = true;
        void actions.firewallAction({ targetId }).then((result) => {
            if (!live) return;
            if (!result.ok) {
                setFailure(result.error);
                return;
            }
            setView(result.data);
            setKeep(new Set(result.data.keep));
        });
        return () => {
            live = false;
        };
    }, [targetId, t]);
    // Kept ports are listed with the ones closing, so keeping one can be undone.
    const choosable = view
        ? [
              ...view.plan.closing,
              ...view.plan.open
                  .filter(({ reason }) => reason === "kept")
                  .map(({ word, detail }) => ({ word, process: detail }))
          ]
        : [];
    const open = view ? view.plan.open.filter(({ reason }) => reason !== "kept") : [];
    const apply = async () => {
        setApplying(true);
        await submit(async () => {
            const result = await actions.applyFirewallAction({ targetId, keep: [...keep] });
            if (result.ok) {
                onApplied(result.data);
                onClose();
            }
            return result;
        }, t("firewall.done"));
        setApplying(false);
    };
    const toggle = (word: string, on: boolean) =>
        setKeep((current) => {
            const next = new Set(current);
            if (on) next.add(word);
            else next.delete(word);
            return next;
        });
    return (
        <Dialog open onOpenChange={(next) => !next && !applying && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("firewall.dialogTitle")}</DialogTitle>
                    <DialogDescription>{t("firewall.dialogHint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 text-sm">
                    {failure ? <ErrorLine t={t} code={failure} /> : null}
                    {!view && !failure ? <Skeleton className="h-40 w-full" /> : null}
                    {view?.plan.blocked === "router" ? (
                        <p className="text-muted-foreground">{t("firewall.hint.router")}</p>
                    ) : null}
                    {view?.plan.replaces ? (
                        <p className="text-warning">{t(`firewall.replaces.${view.plan.replaces}`)}</p>
                    ) : null}
                    {view ? (
                        <section className="flex flex-col gap-2">
                            <h3 className="font-medium">{t("firewall.closes")}</h3>
                            {choosable.length === 0 ? (
                                <p className="text-muted-foreground">{t("firewall.closesNone")}</p>
                            ) : (
                                <ul className="flex flex-col gap-2">
                                    {choosable.map(({ word, process }) => (
                                        <li key={word} className="flex min-w-0 items-center gap-3">
                                            <span className="min-w-0 flex-1">
                                                <span className="block font-mono">
                                                    {portLabel(word)}
                                                </span>
                                                <span
                                                    className="block truncate text-muted-foreground"
                                                    title={process ?? undefined}
                                                >
                                                    {process
                                                        ? t("firewall.notPolaris", { process })
                                                        : t("firewall.notPolarisUnknown")}
                                                </span>
                                            </span>
                                            <label className="flex shrink-0 items-center gap-2">
                                                <span className="text-muted-foreground">
                                                    {t("firewall.keep")}
                                                </span>
                                                <Switch
                                                    checked={keep.has(word)}
                                                    disabled={applying}
                                                    onChange={(on) => toggle(word, on)}
                                                    aria-label={t("firewall.keepPort", {
                                                        port: portLabel(word)
                                                    })}
                                                />
                                            </label>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    ) : null}
                    {view ? (
                        <section className="flex flex-col gap-2">
                            <h3 className="font-medium">{t("firewall.open")}</h3>
                            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                                {open.map(({ word, reason, detail }) => (
                                    <li key={word} className="flex min-w-0 items-center gap-3">
                                        <span className="w-24 shrink-0 font-mono">
                                            {portLabel(word)}
                                        </span>
                                        <span
                                            className="min-w-0 flex-1 truncate text-muted-foreground"
                                            title={detail ?? undefined}
                                        >
                                            {t(`firewall.reason.${reason}`)}
                                            {detail ? ` - ${detail}` : ""}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : null}
                    {applying ? (
                        <p className="text-muted-foreground">{t("firewall.applying")}</p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" disabled={applying} onClick={onClose}>
                        {t("firewall.cancel")}
                    </Button>
                    <Button
                        disabled={!view || applying || view.plan.blocked !== null}
                        onClick={() => void apply()}
                    >
                        {view?.state === "on" ? t("firewall.apply") : t("firewall.turnOn")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

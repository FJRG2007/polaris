"use client";

/**
 * The VPN's Overview: where the control server stands and the address every
 * device signs in to. An administrator also turns it on here - choosing its
 * hostname the first time - turns it off (which keeps every device), and can
 * remove it with everything on it. Anybody else sees the state and is sent on
 * to add a device.
 *
 * The heading and the explanation paint at once; only the status card waits on
 * the control server, and shows the last answer this tab saw while it does.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import * as actions from "./actions";
import { Loader2 } from "lucide-react";
import { useVpnRead } from "./use-vpn-read";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Overview = actions.VpnOverview;
type State = Overview["status"]["state"];

const STATE_VARIANT: Record<State, "neutral" | "success" | "warning" | "danger"> = {
    off: "neutral",
    starting: "warning",
    running: "success",
    failed: "danger"
};

export function VpnOverviewSection({ isAdmin }: { isAdmin: boolean }) {
    const t = useTranslations("vpn");
    const read = useVpnRead<Overview>("overview", actions.vpnOverviewAction, t("errors.generic"));
    const [pending, startTransition] = useTransition();
    const [actionError, setActionError] = useState<string | null>(null);
    const [confirmOff, setConfirmOff] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [choice, setChoice] = useState({ zoneLabel: "", subdomain: "vpn" });
    const [check, setCheck] = useState<HostnameCheck | null>(null);
    const status = read.data?.status ?? null;
    const picking = isAdmin && status?.state === "off" && !status.hostname;

    // A server still starting is asked again until it answers.
    useEffect(() => {
        if (status?.state !== "starting") return;
        const timer = window.setTimeout(read.reload, 4_000);
        return () => window.clearTimeout(timer);
    }, [status?.state, read.reload]);

    function run(action: () => Promise<{ error?: string }>, after?: () => void): void {
        setActionError(null);
        startTransition(async () => {
            const result = await action().catch(() => ({ error: t("errors.generic") }));
            if (result.error) {
                setActionError(result.error);
                return;
            }
            after?.();
            read.reload();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <ui.Card>
                <ui.CardHeader>
                    <ui.CardTitle>{t("overview.title")}</ui.CardTitle>
                </ui.CardHeader>
                <ui.CardBody className="flex flex-col gap-4">
                    {status === null ? (
                        read.error ? (
                            <ErrorLine text={read.error} onRetry={read.reload} />
                        ) : (
                            <div className="flex flex-col gap-2" aria-busy="true">
                                <ui.Skeleton className="h-5 w-32" />
                                <ui.Skeleton className="h-4 w-64 max-w-full" />
                            </div>
                        )
                    ) : (
                        <>
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <ui.Badge variant={STATE_VARIANT[status.state]}>
                                    {t(`state.${status.state}`)}
                                </ui.Badge>
                                <span className="min-w-0 text-sm text-muted-foreground">
                                    {t(`stateHint.${status.state}`)}
                                </span>
                            </div>
                            {status.loginServer && status.state !== "off" ? (
                                <div className="flex min-w-0 flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">
                                        {t("overview.loginServer")}
                                    </span>
                                    <div className="flex min-w-0 items-center gap-2">
                                        <code className="truncate font-mono text-sm" title={status.loginServer}>
                                            {status.loginServer}
                                        </code>
                                        <ui.CopyButton value={status.loginServer} label={t("overview.copy")} />
                                    </div>
                                </div>
                            ) : null}
                            {picking ? (
                                <HostnamePicker
                                    zones={read.data?.zones ?? []}
                                    choice={choice}
                                    onChoice={setChoice}
                                    check={check}
                                    onCheck={setCheck}
                                />
                            ) : null}
                            {isAdmin && status.state === "off" && status.kept ? (
                                <p className="text-sm text-muted-foreground">{t("overview.keptHint")}</p>
                            ) : null}
                            <div className="flex flex-wrap gap-2">
                                {isAdmin && (status.state === "off" || status.state === "failed") ? (
                                    <ui.Button
                                        size="sm"
                                        disabled={pending || (picking && !check?.ok)}
                                        onClick={() => run(() => actions.turnOnVpnAction(choice))}
                                    >
                                        {pending ? <Loader2 className="animate-spin" /> : null}
                                        {status.state === "failed" ? t("actions.retry") : t("actions.turnOn")}
                                    </ui.Button>
                                ) : null}
                                {isAdmin && (status.state === "running" || status.state === "starting") ? (
                                    <ui.Button
                                        size="sm"
                                        variant="outline"
                                        disabled={pending}
                                        onClick={() => setConfirmOff(true)}
                                    >
                                        {t("actions.turnOff")}
                                    </ui.Button>
                                ) : null}
                                {status.state === "running" ? (
                                    <ui.Button asChild size="sm" variant={isAdmin ? "ghost" : "primary"}>
                                        <Link href="/apps/vpn/add">{t("actions.addDevice")}</Link>
                                    </ui.Button>
                                ) : null}
                            </div>
                            {!isAdmin && status.state === "off" ? (
                                <p className="text-sm text-muted-foreground">{t("overview.askAdmin")}</p>
                            ) : null}
                            {actionError ? (
                                <p role="alert" className="text-sm text-danger">
                                    {actionError}
                                </p>
                            ) : null}
                        </>
                    )}
                </ui.CardBody>
            </ui.Card>

            {isAdmin && status && (status.kept || status.hostname) ? (
                <ui.Card className="border-danger-edge">
                    <ui.CardHeader>
                        <ui.CardTitle>{t("remove.title")}</ui.CardTitle>
                    </ui.CardHeader>
                    <ui.CardBody className="flex flex-col items-start gap-3">
                        <p className="text-sm text-muted-foreground">{t("remove.body")}</p>
                        <ui.Button
                            size="sm"
                            variant="danger"
                            disabled={pending}
                            onClick={() => setConfirmRemove(true)}
                        >
                            {t("remove.action")}
                        </ui.Button>
                    </ui.CardBody>
                </ui.Card>
            ) : null}

            <ui.Dialog open={confirmOff} onOpenChange={setConfirmOff}>
                <ui.DialogContent>
                    <ui.DialogHeader>
                        <ui.DialogTitle>{t("turnOff.title")}</ui.DialogTitle>
                        <ui.DialogDescription>{t("turnOff.body")}</ui.DialogDescription>
                    </ui.DialogHeader>
                    <ui.DialogFooter>
                        <ui.DialogClose asChild>
                            <ui.Button variant="ghost" size="sm">
                                {t("actions.cancel")}
                            </ui.Button>
                        </ui.DialogClose>
                        <ui.Button
                            size="sm"
                            disabled={pending}
                            onClick={() => run(actions.turnOffVpnAction, () => setConfirmOff(false))}
                        >
                            {pending ? <Loader2 className="animate-spin" /> : null}
                            {t("actions.turnOff")}
                        </ui.Button>
                    </ui.DialogFooter>
                </ui.DialogContent>
            </ui.Dialog>

            <ui.ConfirmDeleteDialog
                open={confirmRemove}
                onOpenChange={setConfirmRemove}
                kind={t("remove.kind")}
                name={status?.hostname ?? t("page.title")}
                requireTyping
                title={t("remove.title")}
                description={t("remove.confirm")}
                confirmLabel={t("remove.action")}
                pending={pending}
                error={actionError}
                onConfirm={() => run(actions.removeVpnAction, () => setConfirmRemove(false))}
            />
        </div>
    );
}

function ErrorLine({ text, onRetry }: { text: string; onRetry: () => void }) {
    const t = useTranslations("vpn");
    return (
        <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-danger">
                {text}
            </p>
            <ui.Button size="sm" variant="ghost" onClick={onRetry}>
                {t("actions.retry")}
            </ui.Button>
        </div>
    );
}

type HostnameCheck = { text: string; ok: boolean };

/**
 * The hostname the control server will answer on: a zone and a subdomain in
 * it, checked as it is typed the way Deploy's domain field checks one. Chosen
 * once; it stays until the VPN is removed.
 */
function HostnamePicker({
    zones,
    choice,
    onChoice,
    check,
    onCheck: setCheck
}: {
    zones: Overview["zones"];
    choice: { zoneLabel: string; subdomain: string };
    onChoice: (next: { zoneLabel: string; subdomain: string }) => void;
    check: HostnameCheck | null;
    onCheck: (next: HostnameCheck | null) => void;
}) {
    const t = useTranslations("vpn");
    const zoneLabel = choice.zoneLabel || zones.find((zone) => zone.primary)?.label || zones[0]?.label || "";

    useEffect(() => {
        setCheck(null);
        if (!zoneLabel) return;
        let live = true;
        const timer = window.setTimeout(async () => {
            const result = await actions
                .checkVpnHostnameAction({ zoneLabel, subdomain: choice.subdomain })
                .catch(() => ({ error: t("errors.generic") }));
            if (!live) return;
            if (result.error !== undefined) setCheck({ text: result.error, ok: false });
            else if (result.invalid) setCheck({ text: t("hostname.invalid"), ok: false });
            else if (!result.available)
                setCheck({ text: t("hostname.taken", { hostname: result.hostname }), ok: false });
            else setCheck({ text: t("hostname.free", { hostname: result.hostname }), ok: true });
        }, 350);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [zoneLabel, choice.subdomain, t, setCheck]);

    if (zones.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                {t("hostname.noZones")}{" "}
                <Link className="text-primary underline" href="/admin/domains">
                    {t("hostname.openDomains")}
                </Link>
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("hostname.label")}</span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <ui.Input
                    aria-label={t("hostname.subdomain")}
                    className="w-40"
                    value={choice.subdomain}
                    onChange={(event) =>
                        onChoice({ zoneLabel, subdomain: event.target.value.trim().toLowerCase() })
                    }
                />
                <span className="text-sm text-muted-foreground">.</span>
                <ui.Select
                    className="min-w-0 max-w-full sm:w-64"
                    value={zoneLabel}
                    onValueChange={(label) => onChoice({ ...choice, zoneLabel: label })}
                    options={zones.map((zone) => ({ value: zone.label, label: zone.host }))}
                />
            </div>
            {check ? (
                <p className={check.ok ? "text-xs text-muted-foreground" : "text-xs text-danger"}>{check.text}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("hostname.hint")}</p>
        </div>
    );
}

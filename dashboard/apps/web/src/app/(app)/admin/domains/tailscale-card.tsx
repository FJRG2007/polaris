"use client";

/**
 * Remote access through Tailscale. Off until the operator connects; then the card
 * shows the login link the component prints (or takes a pasted auth key), and once
 * signed in the machine's ts.net address, the tailnet, and who it answers: the
 * tailnet (Serve) or the internet too (Funnel). Refreshed in the background, faster
 * while it is waiting on a sign-in.
 */

import { useId, useState } from "react";
import { runAction } from "@/lib/run-action";
import { PageSection } from "@/components/page-section";
import { authKeySchema } from "@/lib/tailscale/tailscale-model";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { TailscaleView } from "@/lib/tailscale/tailscale-service";
import { Button, ConfirmDeleteDialog, CopyButton, Input, Skeleton, Switch } from "@polaris/ui";
import {
    connectTailscaleAction,
    disconnectTailscaleAction,
    setTailscaleTogglesAction,
    type TailscaleResult
} from "./tailscale-actions";

const STATUS_URL = "/api/admin/domains/tailscale";

export function TailscaleCard() {
    const t = useTranslations("admin");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [key, setKey] = useState("");
    const [confirm, setConfirm] = useState(false);
    const keyHint = useId();
    const live = useLiveResource<TailscaleView>({
        url: STATUS_URL,
        cacheKey: "admin.tailscale",
        intervalMs: 5_000,
        select: (body) => body as TailscaleView
    });
    const view = live.data;
    const trimmed = key.trim();
    const keyValid = trimmed === "" || authKeySchema.safeParse(trimmed).success;

    async function run(call: () => Promise<TailscaleResult>, optimistic?: TailscaleView) {
        const before = view;
        if (optimistic) live.replace(optimistic);
        setBusy(true);
        setError("");
        const result = await runAction(call, setError);
        setBusy(false);
        if (result?.error) setError(result.error);
        if (result?.view) live.replace(result.view);
        else if (before) live.replace(before);
        return result;
    }

    async function connect() {
        if (!keyValid) return;
        const result = await run(() => connectTailscaleAction({ authKey: trimmed }));
        if (result?.view) setKey("");
    }

    async function toggle(serve: boolean, funnel: boolean) {
        if (!view) return;
        if (serve === view.config.serve && funnel === view.config.funnel) return;
        await run(() => setTailscaleTogglesAction({ serve, funnel }), {
            ...view,
            config: { ...view.config, serve, funnel }
        });
    }

    const limited = view?.edition === "limited";
    const status = view?.status;
    const on = Boolean(view?.config.enabled) && !limited;

    return (
        <PageSection
            id="tailscale"
            title={t("domains.tailscale.title")}
            description={t("domains.tailscale.description")}
        >
            {!view || !status ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-56" />
                    <Skeleton className="h-8 w-40" />
                </div>
            ) : (
                <div className="flex flex-col gap-4 text-sm">
                    {!on ? (
                        <div className="flex flex-col gap-3">
                            {limited ? (
                                <p className="text-xs text-muted-foreground">
                                    {t("domains.tailscale.limited")}
                                </p>
                            ) : null}
                            <label className="flex min-w-0 flex-col gap-1.5">
                                <span className="text-xs text-muted-foreground">
                                    {t("domains.tailscale.keyLabel")}
                                </span>
                                <Input
                                    type="password"
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={key}
                                    disabled={busy || limited}
                                    aria-invalid={!keyValid}
                                    aria-describedby={keyHint}
                                    placeholder="tskey-auth-..."
                                    onChange={(event) => setKey(event.target.value)}
                                    className="max-w-md"
                                />
                                <span
                                    id={keyHint}
                                    className={
                                        keyValid
                                            ? "text-xs text-muted-foreground"
                                            : "text-xs text-danger"
                                    }
                                >
                                    {keyValid
                                        ? t("domains.tailscale.keyHint")
                                        : t("domains.tailscale.badKey")}
                                </span>
                            </label>
                            <div>
                                <Button
                                    size="sm"
                                    disabled={busy || limited || !keyValid}
                                    title={limited ? t("domains.tailscale.limited") : undefined}
                                    onClick={() => void connect()}
                                >
                                    {busy
                                        ? t("domains.tailscale.connecting")
                                        : t("domains.tailscale.connect")}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <StateLine view={view} />

                            {status.state === "needs-login" ? (
                                <div className="flex flex-col gap-1.5">
                                    {status.loginUrl ? (
                                        <>
                                            <span className="text-xs text-muted-foreground">
                                                {t("domains.tailscale.loginHint")}
                                            </span>
                                            <div className="flex min-w-0 items-center gap-2">
                                                <a
                                                    href={status.loginUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="min-w-0 truncate text-primary hover:underline"
                                                    title={status.loginUrl}
                                                >
                                                    {status.loginUrl}
                                                </a>
                                                <CopyButton value={status.loginUrl} />
                                            </div>
                                        </>
                                    ) : (
                                        <span className="text-xs text-muted-foreground">
                                            {t("domains.tailscale.waitingLink")}
                                        </span>
                                    )}
                                </div>
                            ) : null}

                            {status.state === "connected" && status.host ? (
                                <Address view={view} />
                            ) : null}

                            {status.state === "connected" && status.https === false ? (
                                <Notice>{t("domains.tailscale.httpsOff")}</Notice>
                            ) : null}

                            <Toggle
                                label={t("domains.tailscale.serve")}
                                hint={t("domains.tailscale.serveHint")}
                                checked={view.config.serve}
                                disabled={busy}
                                onChange={(serve) =>
                                    void toggle(serve, serve ? view.config.funnel : false)
                                }
                            />
                            <Toggle
                                label={t("domains.tailscale.funnel")}
                                hint={t("domains.tailscale.funnelHint")}
                                checked={view.config.funnel}
                                disabled={busy || !view.config.serve}
                                reason={
                                    !view.config.serve
                                        ? t("domains.tailscale.funnelNeedsServe")
                                        : undefined
                                }
                                onChange={(funnel) => void toggle(view.config.serve, funnel)}
                            />
                            {view.config.funnel ? (
                                <Notice>{t("domains.tailscale.funnelWarning")}</Notice>
                            ) : null}
                            {view.config.funnel && status.funnelAllowed === false ? (
                                <Notice>{t("domains.tailscale.funnelNotAllowed")}</Notice>
                            ) : null}

                            <div>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => setConfirm(true)}
                                >
                                    {t("domains.tailscale.disconnect")}
                                </Button>
                            </div>
                        </>
                    )}
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
            )}
            <ConfirmDeleteDialog
                open={confirm}
                onOpenChange={setConfirm}
                name={status?.host ?? "Tailscale"}
                kind={t("domains.tailscale.title")}
                title={t("domains.tailscale.disconnectTitle")}
                description={t("domains.tailscale.disconnectBody")}
                confirmLabel={t("domains.tailscale.disconnect")}
                pending={busy}
                onConfirm={async () => {
                    const result = await run(() => disconnectTailscaleAction());
                    if (result?.view) setConfirm(false);
                }}
            />
        </PageSection>
    );
}

function StateLine({ view }: { view: TailscaleView }) {
    const t = useTranslations("admin");
    const { state, tailnet, peers } = view.status;
    const tone =
        state === "connected"
            ? "text-success"
            : state === "stopped"
              ? "text-danger"
              : "text-warning";
    return (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("domains.tailscale.now")}</dt>
            <dd className={`min-w-0 truncate ${tone}`}>{t(`domains.tailscale.states.${state}`)}</dd>
            {tailnet ? (
                <>
                    <dt className="text-muted-foreground">{t("domains.tailscale.tailnet")}</dt>
                    <dd className="min-w-0 truncate" title={tailnet}>
                        {tailnet}
                    </dd>
                </>
            ) : null}
            {state === "connected" ? (
                <>
                    <dt className="text-muted-foreground">{t("domains.tailscale.devices")}</dt>
                    <dd className="min-w-0 truncate">
                        {t("domains.tailscale.peers", { count: peers })}
                    </dd>
                </>
            ) : null}
        </dl>
    );
}

function Address({ view }: { view: TailscaleView }) {
    const t = useTranslations("admin");
    const url = `https://${view.status.host}`;
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{t("domains.tailscale.address")}</span>
            <div className="flex min-w-0 items-center gap-2">
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate font-mono text-primary hover:underline"
                    title={url}
                >
                    {url}
                </a>
                <CopyButton value={url} />
            </div>
            <span className="text-xs text-muted-foreground">
                {view.config.funnel
                    ? t("domains.tailscale.addressPublic")
                    : t("domains.tailscale.addressTailnet")}
            </span>
        </div>
    );
}

function Toggle(props: {
    label: string;
    hint: string;
    checked: boolean;
    disabled: boolean;
    reason?: string;
    onChange: (checked: boolean) => void;
}) {
    const hintId = useId();
    return (
        <div className="flex items-start gap-3">
            <Switch
                checked={props.checked}
                disabled={props.disabled}
                aria-label={props.label}
                aria-describedby={hintId}
                onChange={props.onChange}
            />
            <span className="min-w-0">
                {props.label}
                <span id={hintId} className="block text-xs text-muted-foreground">
                    {props.reason ?? props.hint}
                </span>
            </span>
        </div>
    );
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <p className="break-words rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
            {children}
        </p>
    );
}

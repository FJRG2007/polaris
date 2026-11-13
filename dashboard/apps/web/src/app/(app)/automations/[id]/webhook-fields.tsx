"use client";

/**
 * A webhook trigger's side panel: the address, the methods it answers, the
 * credential a caller proves itself with, "Send test", the caller rules a drop
 * point or an API key takes (collapsed under Advanced), and what arrived.
 *
 * Every value is checked against the same schema the server saves with, as it
 * is typed. The address is a long token, so it is clipped in its field with
 * the whole of it a click away and on the copy button - never a line that
 * widens the panel.
 */

import * as core from "@polaris/core";
import { useAppUrl } from "@/components/app-url";
import { GeoPicker } from "@/components/geo-picker";
import type { NamespaceKey } from "@/lib/i18n/types";
import { RelativeTime } from "@/components/relative-time";
import { PayloadShapeEditor } from "@/components/payload-shape-editor";
import { StepUpDialog } from "@/components/step-up-dialog";
import { RuleListInput } from "@/components/rule-list-input";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { ClientRulesEditor } from "@/components/client-rules-editor";
import type { HookDeliveryView } from "@/lib/automations/webhook-service";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Button, CopyButton, Input, Select, Textarea, cn, useToast } from "@polaris/ui";
import { ChevronDown, Eye, EyeOff, FlaskConical, RefreshCw, ShieldAlert } from "lucide-react";
import {
    listHookDeliveriesAction,
    revealHookSecretAction,
    rotateHookAction,
    sendHookTestAction
} from "../actions";
import * as polls from "../automations-polls";

type Config = Record<string, unknown>;

/** Where "Send test" hands the run it started, so the panel shows its output. */
export const TestRunStarted = createContext<((runId: string) => void) | null>(null);

const DEFAULTS = core.webhookConfigSchema.parse({});

/** The config with the defaults the server would read it with. */
export function webhookView(config: Config): core.WebhookConfig {
    const parsed = core.webhookConfigSchema.safeParse(config);
    return parsed.success ? parsed.data : ({ ...DEFAULTS, ...config } as core.WebhookConfig);
}

/** The schema's complaints, by dotted path, for the fields to show as they are typed. */
export function webhookIssues(config: Config): Set<string> {
    const parsed = core.webhookConfigSchema.safeParse(config);
    return new Set(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join(".")));
}

function Labeled({
    label,
    error,
    hint,
    children
}: {
    label: string;
    error?: string | null;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <label className="block min-w-0 space-y-1 text-sm">
            <span>{label}</span>
            {children}
            {error ? (
                <span className="block text-xs text-destructive">{error}</span>
            ) : hint ? (
                <span className="block text-xs text-muted-foreground">{hint}</span>
            ) : null}
        </label>
    );
}

/** A long value in a field: clipped, whole on hover, unfolded on demand, copyable. */
export function LongValue({ value, label }: { value: string; label: string }) {
    const t = useTranslations("automations");
    const [open, setOpen] = useState(false);
    return (
        <div className="flex min-w-0 items-start gap-1" data-long-value>
            <code
                className={cn(
                    "min-w-0 flex-1 rounded-md border border-border bg-field px-2 py-1.5 font-mono text-xs",
                    open ? "break-all whitespace-pre-wrap" : "truncate whitespace-nowrap"
                )}
                title={value}
                aria-label={label}
            >
                {value}
            </code>
            <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={open ? t("webhook.collapse") : t("webhook.expand")}
                title={open ? t("webhook.collapse") : t("webhook.expand")}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
            </Button>
            <CopyButton value={value} className="shrink-0" />
        </div>
    );
}

/** The address, clipped in its field, whole on demand, copyable. */
export function WebhookAddress({
    detail,
    nodeId,
    rotation,
    onRotate,
    onChanged
}: {
    detail: AutomationDetail;
    nodeId: string;
    rotation: number;
    onRotate: (rotation: number) => void;
    onChanged: () => void;
}) {
    const t = useTranslations("automations");
    const toast = useToast();
    const base = useAppUrl();
    const savedNode = detail.draft.nodes.find((entry) => entry.id === nodeId);
    const savedRotation = (savedNode?.config as { rotation?: unknown } | undefined)?.rotation;
    const known =
        detail.hooks[nodeId] && (savedRotation ?? 0) === rotation ? detail.hooks[nodeId] : null;
    const [asked, setAsked] = useState<{ key: string; path: string } | null>(null);
    const key = `${nodeId}:${rotation}`;
    useEffect(() => {
        if (known || asked?.key === key) return;
        let cancelled = false;
        void polls.hookAddress(detail.id, nodeId, rotation).then((answer) => {
            if (!cancelled && answer.ok) setAsked({ key, path: answer.path });
        });
        return () => {
            cancelled = true;
        };
    }, [known, asked?.key, key, detail.id, nodeId, rotation]);
    const path = known ?? (asked?.key === key ? asked.path : null);
    const url = path ? `${base}${path}` : null;
    return (
        <div className="min-w-0 space-y-1 text-sm">
            <span>{t("editor.webhookUrl")}</span>
            {url ? <LongValue value={url} label={t("editor.webhookUrl")} /> : null}
            <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {t("editor.webhookUnpublished")}
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                        if (!savedNode) return onRotate(rotation + 1);
                        const answer = await rotateHookAction(detail.id, nodeId);
                        toast.show({ title: answer.ok ? t("editor.newAddressDone") : answer.error });
                        if (!answer.ok) return;
                        onRotate(rotation + 1);
                        onChanged();
                    }}
                >
                    {t("editor.newAddress")}
                </Button>
            </div>
        </div>
    );
}

function Methods({ view, set }: { view: core.WebhookConfig; set: (change: Config) => void }) {
    const t = useTranslations("automations");
    const chosen = core.webhookMethods(view);
    return (
        <div className="min-w-0 space-y-1 text-sm">
            <span>{t("webhook.methods")}</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("webhook.methods")}>
                {core.WEBHOOK_METHODS.map((method) => {
                    const on = chosen.includes(method);
                    return (
                        <button
                            key={method}
                            type="button"
                            aria-pressed={on}
                            onClick={() => {
                                const next = on
                                    ? chosen.filter((entry) => entry !== method)
                                    : [...chosen, method];
                                if (next.length === 0) return;
                                set({ methods: core.WEBHOOK_METHODS.filter((entry) => next.includes(entry)) });
                            }}
                            className={cn(
                                "rounded-md border px-2 py-1 font-mono text-xs",
                                on
                                    ? "border-primary bg-primary/10 text-foreground"
                                    : "border-border text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {method}
                        </button>
                    );
                })}
            </div>
            <p className="text-xs text-muted-foreground">{t("webhook.methodsHint")}</p>
        </div>
    );
}

function Secret({
    detail,
    nodeId,
    rotation,
    onRotate
}: {
    detail: AutomationDetail;
    nodeId: string;
    rotation: number;
    onRotate: () => void;
}) {
    const t = useTranslations("automations");
    const toast = useToast();
    const [secret, setSecret] = useState<string | null>(null);
    const [proving, setProving] = useState(false);
    useEffect(() => setSecret(null), [rotation]);
    async function reveal() {
        const answer = await revealHookSecretAction(detail.id, nodeId, rotation);
        if (answer.ok) return setSecret(answer.secret);
        if ("stepUp" in answer && answer.stepUp) return setProving(true);
        toast.show({ title: answer.error });
    }
    return (
        <div className="min-w-0 space-y-1 text-sm">
            <span>{t("webhook.secret")}</span>
            {secret ? <LongValue value={secret} label={t("webhook.secret")} /> : null}
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => (secret ? setSecret(null) : reveal())}>
                    {secret ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    {secret ? t("webhook.hideSecret") : t("webhook.showSecret")}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                        onRotate();
                        toast.show({ title: t("webhook.newSecretDone") });
                    }}
                >
                    {t("webhook.newSecret")}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("webhook.secretHint")}</p>
            <StepUpDialog
                open={proving}
                purpose="automation-hook-secret"
                title={t("webhook.proveTitle")}
                description={t("webhook.proveBody")}
                onOpenChange={setProving}
                onProved={reveal}
            />
        </div>
    );
}

function Auth({
    view,
    raw,
    issues,
    set,
    detail,
    nodeId
}: {
    view: core.WebhookConfig;
    raw: Config;
    issues: Set<string>;
    set: (change: Config) => void;
    detail: AutomationDetail;
    nodeId: string;
}) {
    const t = useTranslations("automations");
    const auth = core.webhookAuth(view);
    const legacy = core.webhookIsLegacyOpen(raw as Pick<core.WebhookConfig, "auth">);
    const bad = (field: string) => (issues.has(`auth.${field}`) ? t("webhook.checkValue") : null);
    const setAuth = (next: Partial<core.WebhookAuth> & { mode?: core.WebhookAuthMode }) =>
        set({ auth: { ...(raw.auth as object | undefined), ...next } });
    const pick = (mode: core.WebhookAuthMode) => {
        if (mode === "none") return set({ auth: { mode } });
        if (mode === "header") return set({ auth: { mode, header: "authorization" } });
        if (mode === "basic") return set({ auth: { mode, username: "polaris" } });
        set({ auth: { mode, preset: "github", ...core.WEBHOOK_HMAC_PRESET_VALUES.github } });
    };
    return (
        <div className="min-w-0 space-y-3">
            <Labeled label={t("webhook.auth")}>
                <Select
                    value={auth.mode}
                    onValueChange={(mode) => pick(mode as core.WebhookAuthMode)}
                    options={core.WEBHOOK_AUTH_MODES.map((mode) => ({
                        value: mode,
                        label: t(`webhook.authModes.${mode}` as NamespaceKey<"automations">)
                    }))}
                    aria-label={t("webhook.auth")}
                />
            </Labeled>
            {auth.mode === "none" ? (
                <p className="flex gap-2 rounded-md bg-warning-soft px-2.5 py-2 text-xs text-warning-foreground">
                    <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">{legacy ? t("webhook.legacyOpen") : t("webhook.openWarning")}</span>
                </p>
            ) : null}
            {auth.mode === "header" ? (
                <Labeled label={t("webhook.headerName")} error={bad("header")} hint={t("webhook.headerHint")}>
                    <Input
                        value={(raw.auth as { header?: string })?.header ?? auth.header}
                        onChange={(event) => setAuth({ header: event.target.value })}
                        aria-invalid={Boolean(bad("header"))}
                        className="font-mono"
                    />
                </Labeled>
            ) : null}
            {auth.mode === "basic" ? (
                <Labeled label={t("webhook.username")} error={bad("username")}>
                    <Input
                        value={(raw.auth as { username?: string })?.username ?? auth.username}
                        onChange={(event) => setAuth({ username: event.target.value })}
                        aria-invalid={Boolean(bad("username"))}
                    />
                </Labeled>
            ) : null}
            {auth.mode === "hmac" ? (
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <Labeled label={t("webhook.preset")}>
                        <Select
                            value={auth.preset}
                            onValueChange={(preset) =>
                                setAuth(
                                    preset === "custom"
                                        ? { preset: "custom" }
                                        : {
                                              preset: preset as "github",
                                              ...core.WEBHOOK_HMAC_PRESET_VALUES[preset as "github"]
                                          }
                                )
                            }
                            options={core.WEBHOOK_HMAC_PRESETS.map((preset) => ({
                                value: preset,
                                label: t(`webhook.presets.${preset}` as NamespaceKey<"automations">)
                            }))}
                            aria-label={t("webhook.preset")}
                        />
                    </Labeled>
                    <Labeled label={t("webhook.algorithm")}>
                        <Select
                            value={auth.algorithm}
                            disabled={auth.preset !== "custom"}
                            onValueChange={(algorithm) => setAuth({ algorithm: algorithm as "sha256" })}
                            options={core.WEBHOOK_HMAC_ALGORITHMS.map((algorithm) => ({
                                value: algorithm,
                                label: algorithm.toUpperCase() // i18n-ignore: an algorithm name
                            }))}
                            aria-label={t("webhook.algorithm")}
                        />
                    </Labeled>
                    <Labeled label={t("webhook.signatureHeader")} error={bad("header")}>
                        <Input
                            value={(raw.auth as { header?: string })?.header ?? auth.header}
                            disabled={auth.preset !== "custom"}
                            onChange={(event) => setAuth({ header: event.target.value })}
                            aria-invalid={Boolean(bad("header"))}
                            className="font-mono"
                        />
                    </Labeled>
                    <Labeled label={t("webhook.prefix")} error={bad("prefix")}>
                        <Input
                            value={auth.prefix}
                            disabled={auth.preset !== "custom"}
                            placeholder="sha256="
                            onChange={(event) => setAuth({ prefix: event.target.value })}
                            className="font-mono"
                        />
                    </Labeled>
                    {auth.preset === "custom" ? (
                        <Labeled
                            label={t("webhook.timestampHeader")}
                            error={bad("timestampHeader")}
                            hint={t("webhook.timestampHint")}
                        >
                            <Input
                                value={(raw.auth as { timestampHeader?: string })?.timestampHeader ?? ""}
                                placeholder="x-timestamp"
                                onChange={(event) => setAuth({ timestampHeader: event.target.value })}
                                aria-invalid={Boolean(bad("timestampHeader"))}
                                className="font-mono"
                            />
                        </Labeled>
                    ) : null}
                    {auth.preset === "stripe" || auth.timestampHeader ? (
                        <Labeled label={t("webhook.tolerance")} error={bad("toleranceSeconds")}>
                            <Input
                                type="number"
                                inputMode="numeric"
                                value={String((raw.auth as { toleranceSeconds?: unknown })?.toleranceSeconds ?? auth.toleranceSeconds)}
                                onChange={(event) => setAuth({ toleranceSeconds: Number(event.target.value) })}
                                aria-invalid={Boolean(bad("toleranceSeconds"))}
                            />
                        </Labeled>
                    ) : null}
                </div>
            ) : null}
            {auth.mode !== "none" ? (
                <Secret
                    detail={detail}
                    nodeId={nodeId}
                    rotation={view.secretRotation}
                    onRotate={() => set({ secretRotation: view.secretRotation + 1 })}
                />
            ) : null}
        </div>
    );
}

function TestBlock({
    detail,
    nodeId,
    view,
    onDelivered
}: {
    detail: AutomationDetail;
    nodeId: string;
    view: core.WebhookConfig;
    onDelivered: () => void;
}) {
    const t = useTranslations("automations");
    const toast = useToast();
    const started = useContext(TestRunStarted);
    const base = useAppUrl();
    const [busy, setBusy] = useState(false);
    const [shown, setShown] = useState(false);
    const saved = detail.draft.nodes.some((entry) => entry.id === nodeId);
    const path = detail.hooks[nodeId] ?? "/api/automations/hooks/<token>";
    const curl = core.webhookCurl(`${base}${path}`, view);
    return (
        <div className="min-w-0 space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !saved}
                    title={saved ? t("webhook.testHint") : t("webhook.saveFirst")}
                    onClick={async () => {
                        setBusy(true);
                        const answer = await sendHookTestAction(detail.id, nodeId);
                        setBusy(false);
                        onDelivered();
                        if (!answer.ok) return void toast.show({ title: answer.error });
                        started?.(answer.runId);
                        toast.show({ title: t("webhook.testSent") });
                    }}
                >
                    <FlaskConical aria-hidden="true" />
                    {busy ? t("webhook.testing") : t("webhook.sendTest")}
                </Button>
                <Button variant="ghost" size="sm" aria-expanded={shown} onClick={() => setShown(!shown)}>
                    {t("webhook.curl")}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                {saved ? t("webhook.testHint") : t("webhook.saveFirst")}
            </p>
            {shown ? (
                <div className="relative min-w-0">
                    <pre className="max-h-56 min-w-0 overflow-auto overscroll-contain rounded-md border border-border bg-field p-2 pr-9 font-mono text-xs">
                        {curl}
                    </pre>
                    <CopyButton value={curl} className="absolute right-1 top-1" />
                </div>
            ) : null}
        </div>
    );
}

const numberField = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

function RateFields({
    label,
    value,
    issues,
    path,
    optional,
    onChange
}: {
    label: string;
    value: { count: number; windowSeconds: number } | null;
    issues: Set<string>;
    path: string;
    optional?: boolean;
    onChange: (next: { count: number; windowSeconds: number } | null) => void;
}) {
    const t = useTranslations("automations");
    const bad = issues.has(`${path}.count`) || issues.has(`${path}.windowSeconds`);
    return (
        <div className="min-w-0 space-y-1 text-sm">
            <span>{label}</span>
            {value ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Input
                        type="number"
                        inputMode="numeric"
                        className="w-24"
                        value={Number.isFinite(value.count) ? String(value.count) : ""}
                        aria-label={t("webhook.rateCount")}
                        aria-invalid={issues.has(`${path}.count`)}
                        onChange={(event) => onChange({ ...value, count: numberField(event.target.value) })}
                    />
                    <span className="text-xs text-muted-foreground">{t("webhook.per")}</span>
                    <Input
                        type="number"
                        inputMode="numeric"
                        className="w-24"
                        value={Number.isFinite(value.windowSeconds) ? String(value.windowSeconds) : ""}
                        aria-label={t("webhook.rateWindow")}
                        aria-invalid={issues.has(`${path}.windowSeconds`)}
                        onChange={(event) =>
                            onChange({ ...value, windowSeconds: numberField(event.target.value) })
                        }
                    />
                    <span className="text-xs text-muted-foreground">{t("webhook.seconds")}</span>
                    {optional ? (
                        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
                            {t("webhook.noLimit")}
                        </Button>
                    ) : null}
                </div>
            ) : (
                <Button variant="outline" size="sm" onClick={() => onChange({ count: 10, windowSeconds: 60 })}>
                    {t("webhook.addLimit")}
                </Button>
            )}
            {bad ? <span className="block text-xs text-destructive">{t("webhook.checkValue")}</span> : null}
        </div>
    );
}

/** The one-line reading of Advanced while it is folded. */
export function advancedSummary(
    view: core.WebhookConfig,
    t: ReturnType<typeof useTranslations<"automations">>
): string {
    const parts: string[] = [];
    if (view.allowedCidrs.length > 0) parts.push(t("webhook.summary.allowed", { count: view.allowedCidrs.length }));
    if (view.deniedCidrs.length > 0) parts.push(t("webhook.summary.blocked", { count: view.deniedCidrs.length }));
    const regions = [...view.allowedCountries, ...view.allowedContinents];
    if (regions.length > 0) parts.push(regions.join(", "));
    if (view.allowedUserAgents.length + view.deniedUserAgents.length > 0)
        parts.push(t("webhook.summary.clients"));
    parts.push(
        t("webhook.summary.rate", {
            count: view.rateLimit.total.count,
            seconds: view.rateLimit.total.windowSeconds
        })
    );
    if (view.rateLimit.perIp)
        parts.push(t("webhook.summary.perIp", { count: view.rateLimit.perIp.count }));
    if (view.maxBodyKb !== core.WEBHOOK_MAX_BODY_KB) parts.push(`${view.maxBodyKb} KB`);
    if (view.contentTypes.length > 0) parts.push(view.contentTypes.join(", "));
    if (view.bodyShape.kind === "structured") parts.push(t("webhook.summary.shaped"));
    parts.push(
        t(view.response.mode === "afterRun" ? "webhook.summary.afterRun" : "webhook.summary.status", {
            status: view.response.status
        })
    );
    return parts.join(" - ");
}

function Advanced({
    view,
    issues,
    set
}: {
    view: core.WebhookConfig;
    issues: Set<string>;
    set: (change: Config) => void;
}) {
    const t = useTranslations("automations");
    const [open, setOpen] = useState(false);
    const summary = advancedSummary(view, t);
    const ip = (draft: string) => {
        const parsed = core.cidrOrIp.safeParse(draft);
        return parsed.success ? { value: parsed.data } : { error: t("webhook.ipInvalid") };
    };
    return (
        <div className="min-w-0 rounded-md border border-border">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left"
            >
                <span className="shrink-0 text-sm font-medium">{t("webhook.advanced")}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={summary}>
                    {summary}
                </span>
                <ChevronDown
                    className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
                    aria-hidden="true"
                />
            </button>
            {open ? (
                <div className="min-w-0 space-y-4 border-t border-border p-2.5">
                    <RuleListInput
                        label={t("webhook.allowIps")}
                        placeholder="203.0.113.0/24"
                        values={view.allowedCidrs}
                        validate={ip}
                        onChange={(allowedCidrs) => set({ allowedCidrs })}
                    />
                    <RuleListInput
                        label={t("webhook.denyIps")}
                        placeholder="198.51.100.7"
                        tone="deny"
                        values={view.deniedCidrs}
                        validate={ip}
                        onChange={(deniedCidrs) => set({ deniedCidrs })}
                    />
                    <GeoPicker
                        countries={view.allowedCountries}
                        continents={view.allowedContinents}
                        onCountries={(allowedCountries) => set({ allowedCountries })}
                        onContinents={(allowedContinents) => set({ allowedContinents })}
                    />
                    <ClientRulesEditor
                        value={{
                            allowedUserAgents: view.allowedUserAgents,
                            deniedUserAgents: view.deniedUserAgents
                        }}
                        onChange={(rules) => set({ ...rules })}
                    />
                    <RateFields
                        label={t("webhook.rateTotal")}
                        value={view.rateLimit.total}
                        issues={issues}
                        path="rateLimit.total"
                        onChange={(total) => total && set({ rateLimit: { ...view.rateLimit, total } })}
                    />
                    <RateFields
                        label={t("webhook.ratePerIp")}
                        value={view.rateLimit.perIp}
                        issues={issues}
                        path="rateLimit.perIp"
                        optional
                        onChange={(perIp) => set({ rateLimit: { ...view.rateLimit, perIp } })}
                    />
                    <Labeled
                        label={t("webhook.maxBody")}
                        error={issues.has("maxBodyKb") ? t("webhook.maxBodyRange", { max: core.WEBHOOK_MAX_BODY_KB }) : null}
                    >
                        <Input
                            type="number"
                            inputMode="numeric"
                            className="w-28"
                            value={Number.isFinite(view.maxBodyKb) ? String(view.maxBodyKb) : ""}
                            aria-invalid={issues.has("maxBodyKb")}
                            onChange={(event) => set({ maxBodyKb: numberField(event.target.value) })}
                        />
                    </Labeled>
                    <RuleListInput
                        label={t("webhook.contentTypes")}
                        placeholder="application/json"
                        hint={t("webhook.contentTypesHint")}
                        values={view.contentTypes}
                        validate={(draft) => {
                            const parsed = core.webhookConfigSchema.shape.contentTypes.safeParse([draft]);
                            return parsed.success && parsed.data[0]
                                ? { value: parsed.data[0] }
                                : { error: t("webhook.contentTypeInvalid") };
                        }}
                        onChange={(contentTypes) => set({ contentTypes })}
                    />
                    <PayloadShapeEditor
                        label={t("webhook.bodyShape")}
                        value={view.bodyShape}
                        onChange={(bodyShape) => set({ bodyShape })}
                    />
                    <PayloadShapeEditor
                        label={t("webhook.queryShape")}
                        value={view.queryShape}
                        onChange={(queryShape) => set({ queryShape })}
                    />
                    <RuleListInput
                        label={t("webhook.requiredHeaders")}
                        placeholder="x-event-type"
                        values={view.requiredHeaders}
                        validate={(draft) => {
                            const parsed = core.webhookConfigSchema.shape.requiredHeaders.safeParse([draft]);
                            return parsed.success && parsed.data[0]
                                ? { value: parsed.data[0] }
                                : { error: t("webhook.checkValue") };
                        }}
                        onChange={(requiredHeaders) => set({ requiredHeaders })}
                    />
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                        <Labeled label={t("webhook.respond")}>
                            <Select
                                value={view.response.mode}
                                onValueChange={(mode) => set({ response: { ...view.response, mode } })}
                                options={core.WEBHOOK_RESPOND_MODES.map((mode) => ({
                                    value: mode,
                                    label: t(`webhook.respondModes.${mode}` as NamespaceKey<"automations">)
                                }))}
                                aria-label={t("webhook.respond")}
                            />
                        </Labeled>
                        <Labeled
                            label={t("webhook.status")}
                            error={issues.has("response.status") ? t("webhook.statusRange") : null}
                        >
                            <Input
                                type="number"
                                inputMode="numeric"
                                value={Number.isFinite(view.response.status) ? String(view.response.status) : ""}
                                aria-invalid={issues.has("response.status")}
                                onChange={(event) =>
                                    set({ response: { ...view.response, status: numberField(event.target.value) } })
                                }
                            />
                        </Labeled>
                    </div>
                    <Labeled label={t("webhook.responseBody")} hint={t("webhook.responseBodyHint")}>
                        <Textarea
                            rows={3}
                            className="font-mono text-xs"
                            value={view.response.body}
                            maxLength={4000}
                            onChange={(event) => set({ response: { ...view.response, body: event.target.value } })}
                        />
                    </Labeled>
                </div>
            ) : null}
        </div>
    );
}

function Deliveries({
    rows,
    loading,
    onRefresh
}: {
    rows: HookDeliveryView[] | null;
    loading: boolean;
    onRefresh: () => void;
}) {
    const t = useTranslations("automations");
    return (
        <div className="min-w-0 space-y-1.5 text-sm">
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{t("webhook.deliveries")}</span>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("webhook.refresh")}
                    title={t("webhook.refresh")}
                    disabled={loading}
                    onClick={onRefresh}
                >
                    <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden="true" />
                </Button>
            </div>
            {rows === null ? (
                <div className="h-10 animate-pulse rounded-md bg-muted" />
            ) : rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("webhook.noDeliveries")}</p>
            ) : (
                <ul className="max-h-64 min-w-0 divide-y divide-border overflow-y-auto overscroll-contain rounded-md border border-border">
                    {rows.map((row) => {
                        const refused = row.reason !== null;
                        const reason = refused
                            ? (core.WEBHOOK_REFUSALS as readonly string[]).includes(row.reason ?? "")
                                ? t(`webhook.refusals.${row.reason}` as NamespaceKey<"automations">)
                                : row.reason
                            : row.test
                              ? t("webhook.testDelivery")
                              : t("webhook.accepted");
                        const where = [row.ip, row.country].filter(Boolean).join(" - ");
                        return (
                            <li key={row.id} className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5 text-xs">
                                <div className="flex min-w-0 items-center gap-2">
                                    <span
                                        className={cn(
                                            "shrink-0 rounded px-1.5 font-mono",
                                            refused ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"
                                        )}
                                    >
                                        {row.status}
                                    </span>
                                    <span className="shrink-0 font-mono">{row.method}</span>
                                    <span className="min-w-0 flex-1 truncate" title={where}>
                                        {where}
                                    </span>
                                    <span className="shrink-0 text-muted-foreground">
                                        <RelativeTime iso={row.at} />
                                    </span>
                                </div>
                                <span
                                    className={cn("min-w-0 truncate", refused ? "text-destructive" : "text-muted-foreground")}
                                    title={row.userAgent ? `${reason} - ${row.userAgent}` : reason}
                                >
                                    {row.detail ? `${reason}: ${row.detail}` : reason}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export function WebhookFields({
    node,
    config,
    set,
    detail,
    onChanged
}: {
    node: core.GraphNode;
    config: Config;
    set: (change: Config) => void;
    detail: AutomationDetail;
    onChanged: () => void;
}) {
    const t = useTranslations("automations");
    const view = webhookView(config);
    const issues = webhookIssues(config);
    const saved = detail.draft.nodes.some((entry) => entry.id === node.id);
    const [rows, setRows] = useState<HookDeliveryView[] | null>(saved ? null : []);
    const [loading, setLoading] = useState(false);
    const load = useCallback(async () => {
        if (!saved) return setRows([]);
        setLoading(true);
        const answer = await listHookDeliveriesAction(detail.id, node.id);
        setLoading(false);
        setRows(answer.ok ? answer.deliveries : []);
    }, [saved, detail.id, node.id]);
    useEffect(() => {
        void load();
    }, [load]);
    return (
        <div className="min-w-0 space-y-4" data-webhook-fields>
            <WebhookAddress
                detail={detail}
                nodeId={node.id}
                rotation={view.rotation}
                onRotate={(rotation) => set({ rotation })}
                onChanged={onChanged}
            />
            <Methods view={view} set={set} />
            <Auth view={view} raw={config} issues={issues} set={set} detail={detail} nodeId={node.id} />
            <TestBlock detail={detail} nodeId={node.id} view={view} onDelivered={() => void load()} />
            <Advanced view={view} issues={issues} set={set} />
            <Deliveries rows={rows} loading={loading} onRefresh={() => void load()} />
            {issues.size > 0 ? <p className="text-xs text-destructive">{t("webhook.fixFields")}</p> : null}
        </div>
    );
}

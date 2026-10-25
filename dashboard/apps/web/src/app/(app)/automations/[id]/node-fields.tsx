"use client";

/**
 * The settings of each core node, shared by the list view and the canvas's
 * side panel, so both edit a node with the same fields and the same checks.
 * Text fields that may hold references offer the values earlier steps give
 * (`RefInput`, `RefTextarea`).
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { findApp } from "@/lib/apps/catalog";
import { listingHref } from "@/lib/apps/marketplace-store";
import {
    Button,
    Checkbox,
    CopyButton,
    Input,
    Select,
    useToast,
    type SelectOption,
    DateInput
} from "@polaris/ui";
import type { SecretSummary } from "@/lib/automations/secrets";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { useEffect, useState } from "react";
import { rotateHookAction } from "../actions";
import type { ChatWebhookChoice } from "@/lib/chat/webhooks";
import { RefInput, RefTextarea } from "./references";
import { CodeEditor } from "@/components/json-view";
import { ThresholdFields } from "./threshold-fields";
import { NoticeDeliveryFields } from "@/components/automations/notice-delivery-fields";
import { AppSlotView } from "@/components/app-extensions/installed-client";
import {
    ConditionEditor,
    FLOW_FIELD_TYPES,
    FlowNodeFields,
    emptyCondition,
    triggerChoices
} from "./flow-fields";
import * as polls from "../automations-polls";

export type T = ReturnType<typeof useTranslations<"automations">>;

/** A service's own name, the same in every language. */
const PRESET_NAMES: Record<core.ChatPreset, string> = {
    slack: "Slack", // i18n-ignore
    discord: "Discord", // i18n-ignore
    teams: "Teams" // i18n-ignore
};

export const TRIGGER_TYPES = [
    "core.manual",
    "core.schedule",
    "core.webhook",
    "core.onEvent",
    "core.failed",
    "core.threshold",
    "core.connectivity",
    "core.called"
] as const;
export const STEP_TYPES = [
    "core.if",
    "core.switch",
    "core.parallel",
    "core.join",
    "core.forEach",
    "core.repeat",
    "core.try",
    "core.wait",
    "core.waitEvent",
    "core.waitCondition",
    "core.notify",
    "core.message",
    "core.http",
    "core.chat",
    "core.run",
    "core.answer",
    "core.set",
    "core.code",
    "core.announce",
    "core.stop"
] as const;

export const DEFAULT_CONFIG: Record<string, () => unknown> = {
    "core.manual": () => ({}),
    "core.schedule": () => ({ kind: "every", amount: 15, unit: "minutes" }),
    "core.webhook": () => ({ method: "POST", rotation: 0 }),
    "core.if": () => ({
        condition: {
            kind: "group",
            join: "all",
            items: [{ kind: "compare", left: "", op: "eq", right: "" }]
        }
    }),
    "core.wait": () => ({ kind: "duration", duration: { amount: 5, unit: "minutes" } }),
    "core.notify": () => ({ title: "", body: "" }),
    "core.message": () => ({ webhookId: "", stamp: "", body: "" }),
    "core.http": () => ({
        method: "POST",
        url: "",
        urlSecretId: null,
        auth: { kind: "none" },
        query: [],
        headers: [],
        body: { kind: "none" },
        timeoutSeconds: 15,
        acceptAnyStatus: false
    }),
    "core.called": () => ({ inputs: [] }),
    "core.onEvent": () => ({ name: "" }),
    "core.failed": () => ({ automations: [] }),
    "core.connectivity": () => ({ event: "up" }),
    "core.threshold": () => ({
        source: "",
        subjectId: "",
        comparator: "gt",
        streak: 3,
        recovery: false
    }),
    "core.switch": () => ({
        kind: "rules",
        cases: [{ label: "", condition: emptyCondition() }],
        every: false,
        fallback: true
    }),
    "core.parallel": () => ({ lanes: 2 }),
    "core.join": () => ({ wait: "all", count: 2, output: "byInput", keep: null }),
    "core.forEach": () => ({ items: "", batch: 1 }),
    "core.repeat": () => ({ kind: "times", count: 3 }),
    "core.stop": () => ({ as: "succeeded", reason: "" }),
    "core.waitEvent": () => ({ name: "", timeout: { amount: 1, unit: "hours" } }),
    "core.try": () => ({ recover: false }),
    "core.waitCondition": () => ({
        condition: {
            kind: "group",
            join: "all",
            items: [{ kind: "compare", left: "", op: "eq", right: "" }]
        },
        timeout: { amount: 1, unit: "hours" },
        every: { amount: 5, unit: "minutes" }
    }),
    "core.run": () => ({ automationId: "", inputs: [], wait: true }),
    "core.answer": () => ({ outputs: [] }),
    "core.set": () => ({ values: [] }),
    "core.announce": () => ({ name: "", payload: [] }),
    "core.redeploy": () => ({ applicationId: "" }),
    "core.code": () => ({ code: CODE_TEMPLATES.filter, items: "" }),
    "core.chat": () => ({
        preset: "slack",
        secretId: "",
        title: "",
        text: "",
        link: "",
        level: "info"
    })
};

export function newNode(type: string): core.GraphNode {
    return {
        id: core.automationNodeId(),
        type,
        typeVersion: 1,
        config: DEFAULT_CONFIG[type]?.() ?? {}
    };
}

export function configValid(node: core.GraphNode): boolean {
    if (core.isCoreNodeType(node.type))
        return core.CORE_NODE_CONFIGS[node.type].safeParse(node.config).success;
    // An app's node is checked by the app, on save and on publish.
    return core.nodeTypeApp(node.type) !== null;
}

/** Where an app's node sends somebody to install the app: its own store page. */
function installHref(app: string): string {
    const manifest = findApp(app);
    return manifest ? listingHref(manifest) : `/apps/marketplace/${encodeURIComponent(app)}`;
}

/** An app's node: drawn by the app where it is installed, and said to need it where it is not. */
function AppNodeFields({
    node,
    setConfig,
    detail
}: {
    node: core.GraphNode;
    setConfig: (config: unknown) => void;
    detail: AutomationDetail;
}) {
    const t = useTranslations("automations");
    const app = core.nodeTypeApp(node.type);
    const slot = app ? detail.appNodes?.[app] : undefined;
    if (slot?.bundle) {
        return (
            <AppSlotView
                slot={{ ...slot, props: { node, setConfig, disabled: !detail.canEdit } }}
            />
        );
    }
    if (slot) return <p className="text-sm text-muted-foreground">{t("nodes.unknown")}</p>;
    return (
        <div
            role="note"
            className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 p-3 text-sm text-muted-foreground"
        >
            <span className="min-w-0 flex-1">{t("appNodes.missing")}</span>
            {app ? (
                <Button asChild size="sm" variant="outline">
                    <Link href={installHref(app)}>{t("appNodes.install")}</Link>
                </Button>
            ) : null}
        </div>
    );
}

type Config = Record<string, any>;

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block min-w-0 space-y-1 text-sm">
            <span>{label}</span>
            {children}
        </label>
    );
}

function Days({ value, onChange }: { value: number[]; onChange: (days: number[]) => void }) {
    const t = useTranslations("automations");
    const keys = ["0", "1", "2", "3", "4", "5", "6"] as const;
    return (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("fields.weekdays")}>
            {keys.map((key) => (
                <label key={key} className="flex items-center gap-1 text-xs">
                    <Checkbox
                        checked={value.includes(Number(key))}
                        onChange={(event) =>
                            onChange(
                                event.target.checked
                                    ? [...value, Number(key)].sort()
                                    : value.filter((day) => day !== Number(key))
                            )
                        }
                    />
                    {t(`weekdays.${key}`)}
                </label>
            ))}
        </div>
    );
}

export function NodeFields({
    node,
    setConfig,
    detail,
    secrets,
    onChanged
}: {
    node: core.GraphNode;
    setConfig: (config: unknown) => void;
    detail: AutomationDetail;
    secrets: SecretSummary[];
    onChanged: () => void;
}) {
    const t = useTranslations("automations");
    const config = (node.config ?? {}) as Config;
    const set = (change: Config) => setConfig({ ...config, ...change });
    const secretOptions = (kinds: readonly string[]) =>
        secrets
            .filter((secret) => kinds.includes(secret.kind))
            .map((secret) => ({ value: secret.id, label: `${secret.name} (${secret.hint})` }));
    const secretPick = (value: string, kinds: readonly string[], onPick: (id: string) => void) => {
        const options = secretOptions(kinds);
        return options.length === 0 ? (
            <p className="text-xs text-muted-foreground">
                {t("fields.noSecrets")}{" "}
                <Link className="underline" href="/automations/secrets">
                    {t("secrets.title")}
                </Link>
            </p>
        ) : (
            <Select
                value={options.some((option) => option.value === value) ? value : ""}
                placeholder={t("fields.chooseSecret")}
                options={options}
                onValueChange={onPick}
                aria-label={t("fields.secret")}
            />
        );
    };
    const units: SelectOption[] = [
        { value: "minutes", label: t("fields.minutes") },
        { value: "hours", label: t("fields.hours") },
        { value: "days", label: t("fields.days") }
    ];

    if (FLOW_FIELD_TYPES.has(node.type))
        return <FlowNodeFields node={node} setConfig={setConfig} detail={detail} />;

    switch (node.type) {
        case "core.manual":
            return null;
        case "core.webhook": {
            return (
                <div className="space-y-3">
                    <Field label={t("fields.method")}>
                        {/* i18n-ignore: HTTP methods, typed as is */}
                        <Select
                            value={config.method ?? "POST"}
                            onValueChange={(method) => set({ method })}
                            options={[
                                { value: "POST", label: "POST" }, // i18n-ignore
                                { value: "GET", label: "GET" }, // i18n-ignore
                                { value: "any", label: t("fields.anyMethod") }
                            ]}
                            aria-label={t("fields.method")}
                        />
                    </Field>
                    <WebhookAddress
                        detail={detail}
                        nodeId={node.id}
                        rotation={typeof config.rotation === "number" ? config.rotation : 0}
                        onRotate={(rotation) => set({ rotation })}
                        onChanged={onChanged}
                    />
                </div>
            );
        }
        case "core.schedule":
            return (
                <div className="space-y-3">
                    <Field label={t("fields.scheduleKind")}>
                        <Select
                            value={config.kind}
                            onValueChange={(kind) =>
                                setConfig(
                                    kind === "every"
                                        ? { kind, amount: 15, unit: "minutes" }
                                        : kind === "daily"
                                          ? { kind, times: ["08:00"], days: [] }
                                          : { kind, expression: "0 8 * * 1-5" }
                                )
                            }
                            options={[
                                { value: "every", label: t("fields.every") },
                                { value: "daily", label: t("fields.daily") },
                                { value: "cron", label: t("fields.cron") }
                            ]}
                            aria-label={t("fields.scheduleKind")}
                        />
                    </Field>
                    {config.kind === "every" ? (
                        <div className="grid grid-cols-2 gap-3">
                            <Field label={t("fields.amount")}>
                                <Input
                                    type="number"
                                    min={1}
                                    value={config.amount ?? ""}
                                    onChange={(event) =>
                                        set({ amount: event.target.valueAsNumber })
                                    }
                                />
                            </Field>
                            <Field label={t("fields.unit")}>
                                <Select
                                    value={config.unit}
                                    onValueChange={(unit) => set({ unit })}
                                    options={units}
                                    aria-label={t("fields.unit")}
                                />
                            </Field>
                        </div>
                    ) : config.kind === "daily" ? (
                        <>
                            <Field label={t("fields.times")}>
                                <Input
                                    value={(config.times ?? []).join(", ")}
                                    onChange={(event) =>
                                        set({
                                            times: event.target.value
                                                .split(",")
                                                .map((part) => part.trim())
                                                .filter(Boolean)
                                        })
                                    }
                                    placeholder="08:00, 18:30"
                                />
                            </Field>
                            <Days value={config.days ?? []} onChange={(days) => set({ days })} />
                        </>
                    ) : (
                        <Field label={t("fields.expression")}>
                            <Input
                                value={config.expression ?? ""}
                                onChange={(event) => set({ expression: event.target.value })}
                                placeholder="0 8 * * 1-5"
                            />
                        </Field>
                    )}
                </div>
            );
        case "core.if":
            return (
                <ConditionEditor
                    value={config.condition as core.ConditionGroup}
                    onChange={(condition) => set({ condition })}
                    triggers={triggerChoices(t, detail.draft)}
                />
            );
        case "core.wait":
            return (
                <div className="space-y-3">
                    <Field label={t("fields.waitKind")}>
                        <Select
                            value={config.kind}
                            onValueChange={(kind) =>
                                setConfig(
                                    kind === "duration"
                                        ? { kind, duration: { amount: 5, unit: "minutes" } }
                                        : { kind, time: "08:00", days: [] }
                                )
                            }
                            options={[
                                { value: "duration", label: t("fields.waitDuration") },
                                { value: "until", label: t("fields.waitUntil") }
                            ]}
                            aria-label={t("fields.waitKind")}
                        />
                    </Field>
                    {config.kind === "duration" ? (
                        <div className="grid grid-cols-2 gap-3">
                            <Field label={t("fields.amount")}>
                                <Input
                                    type="number"
                                    min={0}
                                    value={config.duration?.amount ?? ""}
                                    onChange={(event) =>
                                        set({
                                            duration: {
                                                ...config.duration,
                                                amount: event.target.valueAsNumber
                                            }
                                        })
                                    }
                                />
                            </Field>
                            <Field label={t("fields.unit")}>
                                <Select
                                    value={config.duration?.unit}
                                    onValueChange={(unit) =>
                                        set({ duration: { ...config.duration, unit } })
                                    }
                                    options={[
                                        { value: "seconds", label: t("fields.seconds") },
                                        ...units
                                    ]}
                                    aria-label={t("fields.unit")}
                                />
                            </Field>
                        </div>
                    ) : (
                        <>
                            <Field label={t("fields.time")}>
                                <DateInput
                                    mode="time"
                                    value={config.time ?? ""}
                                    onChange={(event) => set({ time: event.target.value })}
                                />
                            </Field>
                            <Days value={config.days ?? []} onChange={(days) => set({ days })} />
                        </>
                    )}
                </div>
            );
        case "core.notify":
            return (
                <div className="space-y-3">
                    <Field label={`${t("fields.title")} *`}>
                        <RefInput
                            value={config.title ?? ""}
                            maxLength={200}
                            onChange={(event) => set({ title: event.target.value })}
                        />
                    </Field>
                    <Field label={t("fields.body")}>
                        <RefTextarea
                            rows={3}
                            value={config.body ?? ""}
                            onChange={(event) => set({ body: event.target.value })}
                        />
                    </Field>
                    <NoticeDeliveryFields
                        value={config.delivery}
                        onChange={(delivery) => set({ delivery })}
                    />
                </div>
            );
        case "core.message":
            return <ChatMessageFields config={config} set={set} />;
        case "core.redeploy":
            return <RedeployFields config={config} set={set} />;
        case "core.code":
            return <CodeFields config={config} set={set} />;
        case "core.connectivity":
            return (
                <Field label={t("connectivity.when")}>
                    <Select
                        value={typeof config.event === "string" ? config.event : "up"}
                        onValueChange={(event) => set({ event })}
                        options={core.CONNECTIVITY_TRIGGER_EVENTS.map((event) => ({
                            value: event,
                            label: t(`connectivity.events.${event}`)
                        }))}
                        aria-label={t("connectivity.when")}
                    />
                </Field>
            );
        case "core.threshold":
            return <ThresholdFields config={config} set={set} setConfig={setConfig} />;
        case "core.chat":
            return (
                <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("fields.preset")}>
                            <Select
                                value={config.preset}
                                onValueChange={(preset) => set({ preset })}
                                options={core.CHAT_PRESETS.map((preset) => ({
                                    value: preset,
                                    label: PRESET_NAMES[preset]
                                }))}
                                aria-label={t("fields.preset")}
                            />
                        </Field>
                        <Field label={`${t("fields.secret")} *`}>
                            {secretPick(config.secretId ?? "", ["url"], (secretId) =>
                                set({ secretId })
                            )}
                        </Field>
                    </div>
                    <Field label={`${t("fields.title")} *`}>
                        <RefInput
                            value={config.title ?? ""}
                            maxLength={256}
                            onChange={(event) => set({ title: event.target.value })}
                        />
                    </Field>
                    <Field label={t("fields.body")}>
                        <RefTextarea
                            rows={3}
                            value={config.text ?? ""}
                            onChange={(event) => set({ text: event.target.value })}
                        />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("fields.link")}>
                            <RefInput
                                value={config.link ?? ""}
                                onChange={(event) => set({ link: event.target.value })}
                            />
                        </Field>
                        <Field label={t("fields.level")}>
                            <Select
                                value={config.level}
                                onValueChange={(level) => set({ level })}
                                options={[
                                    { value: "info", label: t("fields.levelInfo") },
                                    { value: "success", label: t("fields.levelSuccess") },
                                    { value: "warning", label: t("fields.levelWarning") },
                                    { value: "danger", label: t("fields.levelDanger") }
                                ]}
                                aria-label={t("fields.level")}
                            />
                        </Field>
                    </div>
                </div>
            );
        case "core.http": {
            const fromSecret = config.urlSecretId !== null && config.urlSecretId !== undefined;
            const auth = (config.auth ?? { kind: "none" }) as Config;
            const body = (config.body ?? { kind: "none" }) as Config;
            return (
                <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                        <Field label={t("fields.method")}>
                            <Select
                                value={config.method}
                                onValueChange={(method) => set({ method })}
                                options={core.HTTP_METHODS.map((method) => ({
                                    value: method,
                                    label: method
                                }))}
                                aria-label={t("fields.method")}
                            />
                        </Field>
                        <Field label={t("fields.url")}>
                            <Select
                                value={fromSecret ? "secret" : "typed"}
                                onValueChange={(source) =>
                                    set(
                                        source === "secret"
                                            ? { urlSecretId: "", url: "" }
                                            : { urlSecretId: null }
                                    )
                                }
                                options={[
                                    { value: "typed", label: t("fields.urlTyped") },
                                    { value: "secret", label: t("fields.urlFromSecret") }
                                ]}
                                aria-label={t("fields.url")}
                            />
                        </Field>
                    </div>
                    {fromSecret ? (
                        secretPick(config.urlSecretId, ["url"], (urlSecretId) =>
                            set({ urlSecretId })
                        )
                    ) : (
                        <RefInput
                            aria-label={t("fields.url")}
                            value={config.url ?? ""}
                            placeholder="https://api.example.com/items"
                            onChange={(event) => set({ url: event.target.value })}
                        />
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("fields.auth")}>
                            <Select
                                value={auth.kind}
                                onValueChange={(kind) =>
                                    set({
                                        auth:
                                            kind === "none"
                                                ? { kind }
                                                : kind === "header"
                                                  ? { kind, secretId: "", header: "X-Api-Key" }
                                                  : { kind, secretId: "" }
                                    })
                                }
                                options={[
                                    { value: "none", label: t("fields.authNone") },
                                    { value: "bearer", label: t("fields.authBearer") },
                                    { value: "basic", label: t("fields.authBasic") },
                                    { value: "header", label: t("fields.authHeader") }
                                ]}
                                aria-label={t("fields.auth")}
                            />
                        </Field>
                        {auth.kind !== "none" ? (
                            <Field label={t("fields.secret")}>
                                {secretPick(
                                    auth.secretId ?? "",
                                    auth.kind === "basic"
                                        ? ["basic"]
                                        : auth.kind === "header"
                                          ? ["header", "token"]
                                          : ["token"],
                                    (secretId) => set({ auth: { ...auth, secretId } })
                                )}
                            </Field>
                        ) : null}
                        {auth.kind === "header" ? (
                            <Field label={t("fields.header")}>
                                <Input
                                    value={auth.header ?? ""}
                                    onChange={(event) =>
                                        set({ auth: { ...auth, header: event.target.value } })
                                    }
                                />
                            </Field>
                        ) : null}
                    </div>
                    {config.method !== "GET" && config.method !== "HEAD" ? (
                        <>
                            <Field label={t("fields.bodyKind")}>
                                <Select
                                    value={body.kind}
                                    onValueChange={(kind) =>
                                        set({
                                            body:
                                                kind === "json"
                                                    ? { kind, json: "{}" }
                                                    : kind === "text"
                                                      ? { kind, text: "" }
                                                      : { kind }
                                        })
                                    }
                                    options={[
                                        { value: "none", label: t("fields.bodyNone") },
                                        { value: "json", label: t("fields.bodyJson") },
                                        { value: "text", label: t("fields.bodyText") }
                                    ]}
                                    aria-label={t("fields.bodyKind")}
                                />
                            </Field>
                            {body.kind === "json" ? (
                                <RefTextarea
                                    aria-label={t("fields.json")}
                                    rows={5}
                                    className="font-mono text-xs"
                                    value={body.json ?? ""}
                                    onChange={(event) =>
                                        set({ body: { kind: "json", json: event.target.value } })
                                    }
                                />
                            ) : body.kind === "text" ? (
                                <RefTextarea
                                    aria-label={t("fields.text")}
                                    rows={4}
                                    value={body.text ?? ""}
                                    onChange={(event) =>
                                        set({ body: { kind: "text", text: event.target.value } })
                                    }
                                />
                            ) : null}
                        </>
                    ) : null}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("fields.timeout")}>
                            <Input
                                type="number"
                                min={1}
                                max={30}
                                value={config.timeoutSeconds ?? 15}
                                onChange={(event) =>
                                    set({ timeoutSeconds: event.target.valueAsNumber })
                                }
                            />
                        </Field>
                        <label className="flex items-center gap-2 self-end text-sm">
                            <Checkbox
                                checked={Boolean(config.acceptAnyStatus)}
                                onChange={(event) => set({ acceptAnyStatus: event.target.checked })}
                            />
                            {t("fields.acceptAnyStatus")}
                        </label>
                    </div>
                </div>
            );
        }
        default:
            if (core.nodeTypeApp(node.type))
                return <AppNodeFields node={node} setConfig={setConfig} detail={detail} />;
            return <p className="text-sm text-muted-foreground">{t("nodes.unknown")}</p>;
    }
}

/**
 * A webhook trigger's address, from the moment the trigger is added: the saved
 * one when the editor holds the saved rotation, asked for otherwise. "New
 * address" on a trigger that is not saved yet only moves the rotation here;
 * the next save keeps it.
 */
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
    const url = path && typeof window !== "undefined" ? `${window.location.origin}${path}` : null;
    return (
        <div className="space-y-1 text-sm">
            <span>{t("editor.webhookUrl")}</span>
            {url ? (
                <div className="flex min-w-0 items-center gap-2">
                    <code
                        className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs"
                        title={url}
                    >
                        {url}
                    </code>
                    <CopyButton value={url} />
                </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("editor.webhookUnpublished")}</p>
            <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                    if (!savedNode) {
                        onRotate(rotation + 1);
                        return;
                    }
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
    );
}

/**
 * Where "Post to a chat channel" posts, and what it says.
 *
 * It posts through one of a channel's webhooks, under the webhook's name, so
 * the list is the webhooks on the space channels the person editing runs.
 * Whether the account the automation runs as still runs that channel is asked
 * again when it is saved and on every run.
 */
function ChatMessageFields({ config, set }: { config: Config; set: (change: Config) => void }) {
    const t = useTranslations("automations");
    const [webhooks, setWebhooks] = useState<readonly ChatWebhookChoice[] | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let cancelled = false;
        void polls.chatWebhooks().then((answer) => {
            if (cancelled) return;
            if (answer.ok) setWebhooks(answer.webhooks);
            else setError(answer.error);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const options: SelectOption[] = (webhooks ?? []).map((entry) => ({
        value: entry.id,
        label: t("fields.webhookOption", {
            name: entry.name,
            channel: entry.channelName,
            space: entry.spaceName
        })
    }));
    const chosenId = typeof config.webhookId === "string" ? config.webhookId : "";
    const chosen = webhooks?.find((entry) => entry.id === chosenId) ?? null;
    const missing = webhooks !== null && chosenId !== "" && !chosen;
    const reset = chosen !== null && chosen.stamp !== config.stamp;
    return (
        <div className="space-y-3">
            <Field label={`${t("fields.webhook")} *`}>
                <Select
                    value={chosenId}
                    onValueChange={(webhookId) => {
                        const entry = webhooks?.find((option) => option.id === webhookId);
                        if (entry) set({ webhookId: entry.id, stamp: entry.stamp });
                    }}
                    options={options}
                    placeholder={t(
                        webhooks === null ? "fields.webhookLoading" : "fields.webhookPick"
                    )}
                    aria-label={t("fields.webhook")}
                />
            </Field>
            {error && <p className="text-xs text-danger-ink">{error}</p>}
            {webhooks !== null && options.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    {t("fields.webhookNone")}{" "}
                    <Link className="underline" href="/chat">
                        {t("fields.webhookOpenChat")}
                    </Link>
                </p>
            )}
            {missing && <p className="text-xs text-danger-ink">{t("fields.webhookGone")}</p>}
            {reset && (
                <div className="space-y-2 rounded-md border border-warning-edge bg-warning-soft p-2 text-xs text-warning-ink">
                    <p>{t("fields.webhookReset")}</p>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => set({ webhookId: chosen.id, stamp: chosen.stamp })}
                    >
                        {t("fields.webhookUseNew")}
                    </Button>
                </div>
            )}
            {chosen && !reset && (
                <p className="min-w-0 text-xs text-muted-foreground">
                    <span className="break-words">
                        {t("fields.webhookPostsAs", { name: chosen.name })}
                    </span>{" "}
                    <Link
                        className="underline"
                        href={`/chat/c/${chosen.channelId}/settings/integrations`}
                    >
                        {t("fields.webhookManage")}
                    </Link>
                </p>
            )}
            <Field label={`${t("fields.body")} *`}>
                <RefTextarea
                    rows={3}
                    value={config.body ?? ""}
                    onChange={(event) => set({ body: event.target.value })}
                />
            </Field>
        </div>
    );
}

/** Starting points for a Code step; picking one replaces the code. */
export const CODE_TEMPLATES = {
    // i18n-ignore: example code
    filter: "// Keep the items that match.\nreturn items.filter((item) => item.price > 10);\n",
    // i18n-ignore: example code
    map: "// Change each item.\nreturn items.map((item) => ({ ...item, total: item.price * item.quantity }));\n",
    // i18n-ignore: example code
    aggregate:
        "// Sum the items into one.\nconst total = items.reduce((sum, item) => sum + item.price, 0);\nreturn [{ total, count: items.length }];\n"
} as const;
type CodeTemplate = keyof typeof CODE_TEMPLATES;

function CodeFields({ config, set }: { config: Config; set: (change: Config) => void }) {
    const t = useTranslations("automations");
    const code = typeof config.code === "string" ? config.code : "";
    const tooLong = code.length > core.AUTOMATION_LIMITS.codeLength;
    return (
        <div className="space-y-3">
            <Field label={t("code.items")}>
                <RefInput
                    value={typeof config.items === "string" ? config.items : ""}
                    maxLength={500}
                    placeholder={t("code.itemsPlaceholder")}
                    onChange={(event) => set({ items: event.target.value })}
                />
            </Field>
            <Field label={t("code.template")}>
                <Select
                    value=""
                    onValueChange={(name) => set({ code: CODE_TEMPLATES[name as CodeTemplate] })}
                    options={(Object.keys(CODE_TEMPLATES) as CodeTemplate[]).map((name) => ({
                        value: name,
                        label: t(`code.templates.${name}`)
                    }))}
                    placeholder={t("code.templatePick")}
                    aria-label={t("code.template")}
                />
            </Field>
            <div className="min-w-0 space-y-1 text-sm">
                <span>{`${t("code.code")} *`}</span>
                <CodeEditor
                    value={code}
                    onChange={(next) => set({ code: next })}
                    language="javascript"
                    label={t("code.code")}
                    invalid={tooLong}
                    className="max-h-96"
                />
                <span className={tooLong ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
                    {tooLong ? t("code.tooLong") : t("code.hint")}
                </span>
            </div>
        </div>
    );
}

/**
 * Which service "Redeploy a service" deploys: the services the person editing
 * runs. The run asks again, as the run-as account, whether it may deploy it.
 */
function RedeployFields({ config, set }: { config: Config; set: (change: Config) => void }) {
    const t = useTranslations("automations");
    const [services, setServices] = useState<readonly { id: string; name: string }[] | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let cancelled = false;
        void polls.thresholdChoices().then((answer) => {
            if (cancelled) return;
            if (answer.ok)
                setServices(answer.kinds.find((kind) => kind.kind === "app")?.subjects ?? []);
            else setError(answer.error);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const chosenId = typeof config.applicationId === "string" ? config.applicationId : "";
    const missing =
        services !== null && chosenId !== "" && !services.some((entry) => entry.id === chosenId);
    return (
        <div className="space-y-3">
            <Field label={`${t("fields.service")} *`}>
                <Select
                    value={chosenId}
                    onValueChange={(applicationId) => set({ applicationId })}
                    options={(services ?? []).map((entry) => ({
                        value: entry.id,
                        label: entry.name
                    }))}
                    placeholder={t(
                        services === null ? "fields.serviceLoading" : "fields.servicePick"
                    )}
                    aria-label={t("fields.service")}
                />
            </Field>
            {error && <p className="text-xs text-danger-ink">{error}</p>}
            {services !== null && services.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    {t("fields.serviceNone")}{" "}
                    <Link className="underline" href="/apps/deploy">
                        {t("fields.serviceOpenDeploy")}
                    </Link>
                </p>
            )}
            {missing && <p className="text-xs text-danger-ink">{t("fields.serviceGone")}</p>}
        </div>
    );
}

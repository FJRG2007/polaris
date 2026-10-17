"use client";

/**
 * The settings of each core node, shared by the list view and the canvas's
 * side panel, so both edit a node with the same fields and the same checks.
 * Text fields that may hold references offer the values earlier steps give
 * (`RefInput`, `RefTextarea`).
 */

import Link from "next/link";
import * as core from "@polaris/core";
import {
    Button,
    Checkbox,
    CopyButton,
    Input,
    Select,
    useToast,
    type SelectOption
} from "@polaris/ui";
import type { SecretSummary } from "@/lib/automations/secrets";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { rotateHookAction } from "../actions";
import { RefInput, RefTextarea } from "./references";
import {
    ConditionEditor,
    FLOW_FIELD_TYPES,
    FlowNodeFields,
    emptyCondition,
    triggerChoices
} from "./flow-fields";

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
    "core.called"
] as const;
export const STEP_TYPES = [
    "core.if",
    "core.switch",
    "core.parallel",
    "core.join",
    "core.forEach",
    "core.repeat",
    "core.wait",
    "core.waitEvent",
    "core.notify",
    "core.http",
    "core.chat",
    "core.run",
    "core.answer",
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
    "core.run": () => ({ automationId: "", inputs: [], wait: true }),
    "core.answer": () => ({ outputs: [] }),
    "core.announce": () => ({ name: "", payload: [] }),
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
    return core.isCoreNodeType(node.type)
        ? core.CORE_NODE_CONFIGS[node.type].safeParse(node.config).success
        : false;
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
    const toast = useToast();
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
            const path = detail.hooks[node.id];
            const url =
                path && typeof window !== "undefined" ? `${window.location.origin}${path}` : null;
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
                        <p className="text-xs text-muted-foreground">
                            {t("editor.webhookUnpublished")}
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                                const answer = await rotateHookAction(detail.id, node.id);
                                toast.show({
                                    title: answer.ok ? t("editor.newAddressDone") : answer.error
                                });
                                if (!answer.ok) return;
                                set({
                                    rotation:
                                        (typeof config.rotation === "number"
                                            ? config.rotation
                                            : 0) + 1
                                });
                                onChanged();
                            }}
                        >
                            {t("editor.newAddress")}
                        </Button>
                    </div>
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
                                <Input
                                    type="time"
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
                </div>
            );
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
            return <p className="text-sm text-muted-foreground">{t("nodes.unknown")}</p>;
    }
}

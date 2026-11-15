"use client";

/**
 * The settings of Polar's steps: write, run an agent, decide, extract. Each
 * picks a model (Automatic, or one from the owner's own providers) and,
 * optionally, one of their custom Polar agents.
 */

import * as core from "@polaris/core";
import { RefTextarea } from "./references";
import { Plus, Trash2 } from "lucide-react";
import { PagedPicker } from "@/components/paged-picker";
import { Button, Checkbox, Input, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { polarAgentOptionsAction, polarModelOptionsAction } from "../actions";

type Config = Record<string, unknown>;
type Props = { config: Config; set: (change: Config) => void };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** The picker's id for a model: provider and model id, which neither may contain twice. */
export function modelKey(model: unknown): string {
    const parsed = core.aiModelSchema.safeParse(model);
    return parsed.success && parsed.data ? `${parsed.data.provider}::${parsed.data.model}` : "";
}

function ModelAndAgent({ config, set, agentRequired }: Props & { agentRequired?: boolean }) {
    const t = useTranslations("automations");
    const key = modelKey(config.model);
    const agentId = str(config.agentId);
    return (
        <>
            <label className="block min-w-0 space-y-1 text-sm">
                <span>{t("fields.aiModel")}</span>
                <PagedPicker
                    read={polarModelOptionsAction}
                    scope={{}}
                    cache="automations:polar-models"
                    value={key}
                    onValueChange={(id) => {
                        const [provider, ...rest] = id.split("::");
                        set({ model: provider && rest.length ? { provider, model: rest.join("::") } : null });
                    }}
                    placeholder={t("fields.aiModelAuto")}
                    searchPlaceholder={t("fields.aiModelSearch")}
                    emptyText={t("fields.aiModelNone")}
                    aria-label={t("fields.aiModel")}
                />
            </label>
            {key ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => set({ model: null })}>
                    {t("fields.aiModelReset")}
                </Button>
            ) : null}
            <label className="block min-w-0 space-y-1 text-sm">
                <span>{agentRequired ? t("fields.askAgent") : t("fields.aiAgentOptional")}</span>
                <PagedPicker
                    read={polarAgentOptionsAction}
                    scope={{}}
                    cache="automations:polar-agents"
                    value={agentId}
                    onValueChange={(id) => set({ agentId: id })}
                    placeholder={t("fields.aiAgentNone")}
                    searchPlaceholder={t("fields.askAgentSearch")}
                    emptyText={t("fields.askAgentNone")}
                    aria-label={t("fields.aiAgentOptional")}
                />
            </label>
            {agentId ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => set({ agentId: "" })}>
                    {t("fields.aiAgentClear")}
                </Button>
            ) : null}
        </>
    );
}

function TextField({
    label,
    hint,
    value,
    onChange,
    rows = 4
}: {
    label: string;
    hint?: string;
    value: string;
    onChange: (value: string) => void;
    rows?: number;
}) {
    return (
        <label className="block min-w-0 space-y-1 text-sm">
            <span>{label}</span>
            <RefTextarea rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
            {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </label>
    );
}

function NumberField({
    label,
    value,
    min,
    max,
    onChange
}: {
    label: string;
    value: unknown;
    min: number;
    max: number;
    onChange: (value: number) => void;
}) {
    return (
        <label className="block min-w-0 space-y-1 text-sm">
            <span className="block truncate" title={label}>
                {label}
            </span>
            <Input
                type="number"
                min={min}
                max={max}
                value={typeof value === "number" && Number.isFinite(value) ? value : ""}
                onChange={(event) => onChange(event.target.valueAsNumber)}
            />
        </label>
    );
}

export function AiWriteFields({ config, set }: Props) {
    const t = useTranslations("automations");
    return (
        <div className="space-y-3">
            <TextField
                label={t("fields.aiPrompt")}
                hint={t("fields.aiPromptHint")}
                value={str(config.prompt)}
                onChange={(prompt) => set({ prompt })}
            />
            <ModelAndAgent config={config} set={set} />
        </div>
    );
}

export function AiAgentFields({ config, set }: Props) {
    const t = useTranslations("automations");
    return (
        <div className="space-y-3">
            <TextField
                label={t("fields.aiTask")}
                hint={t("fields.aiTaskHint")}
                value={str(config.task)}
                onChange={(task) => set({ task })}
            />
            <ModelAndAgent config={config} set={set} />
            <div className="grid grid-cols-3 gap-2">
                <NumberField
                    label={t("fields.aiMaxSteps")}
                    value={config.maxSteps}
                    min={1}
                    max={20}
                    onChange={(maxSteps) => set({ maxSteps })}
                />
                <NumberField
                    label={t("fields.aiMaxTokens")}
                    value={config.maxTokens}
                    min={256}
                    max={64_000}
                    onChange={(maxTokens) => set({ maxTokens })}
                />
                <NumberField
                    label={t("fields.aiTimeout")}
                    value={config.timeoutSeconds}
                    min={10}
                    max={600}
                    onChange={(timeoutSeconds) => set({ timeoutSeconds })}
                />
            </div>
        </div>
    );
}

type Outcome = { label: string; description: string };

export function AiDecideFields({ config, set }: Props) {
    const t = useTranslations("automations");
    const cases = list<Outcome>(config.cases);
    const put = (next: Outcome[]) => {
        // An outcome the failures went to and that is gone sends them to the error path.
        const failure = str(config.onFailure);
        const index = /^case(\d+)$/.exec(failure);
        set({
            cases: next,
            ...(index && Number(index[1]) > next.length ? { onFailure: "error" } : {})
        });
    };
    const failure = str(config.onFailure) || "error";
    return (
        <div className="space-y-3">
            <TextField
                label={t("fields.aiDecideInput")}
                value={str(config.input)}
                onChange={(input) => set({ input })}
            />
            <TextField
                label={t("fields.aiDecideInstructions")}
                rows={2}
                value={str(config.instructions)}
                onChange={(instructions) => set({ instructions })}
            />
            <div className="space-y-2" role="group" aria-label={t("fields.aiOutcomes")}>
                <p className="text-sm">{t("fields.aiOutcomes")}</p>
                {cases.map((entry, index) => (
                    <div key={index} className="flex min-w-0 items-start gap-2">
                        <div className="min-w-0 flex-1 space-y-1">
                            <Input
                                value={entry.label}
                                maxLength={60}
                                placeholder={t("fields.aiOutcomeLabel", { number: index + 1 })}
                                aria-label={t("fields.aiOutcomeLabel", { number: index + 1 })}
                                onChange={(event) =>
                                    put(cases.map((one, at) => (at === index ? { ...one, label: event.target.value } : one)))
                                }
                            />
                            <Input
                                value={entry.description}
                                maxLength={300}
                                placeholder={t("fields.aiOutcomeDescription")}
                                aria-label={t("fields.aiOutcomeDescription")}
                                onChange={(event) =>
                                    put(
                                        cases.map((one, at) =>
                                            at === index ? { ...one, description: event.target.value } : one
                                        )
                                    )
                                }
                            />
                        </div>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={cases.length <= 2}
                            title={t("fields.aiOutcomeRemove")}
                            aria-label={t("fields.aiOutcomeRemove")}
                            onClick={() => put(cases.filter((_, at) => at !== index))}
                        >
                            <Trash2 aria-hidden="true" />
                        </Button>
                    </div>
                ))}
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={cases.length >= core.AUTOMATION_LIMITS.switchCases}
                    onClick={() => put([...cases, { label: "", description: "" }])}
                >
                    <Plus aria-hidden="true" />
                    {t("fields.aiOutcomeAdd")}
                </Button>
            </div>
            <label className="block min-w-0 space-y-1 text-sm">
                <span>{t("fields.aiOnFailure")}</span>
                <Select
                    value={failure}
                    onValueChange={(onFailure) => set({ onFailure })}
                    options={[
                        { value: "error", label: t("fields.aiOnFailureError") },
                        { value: "fail", label: t("fields.aiOnFailureFail") },
                        ...cases.map((entry, index) => ({
                            value: `case${index + 1}`,
                            label: t("fields.aiOnFailureCase", {
                                label: entry.label.trim() || t("canvas.ports.case", { number: index + 1 })
                            })
                        }))
                    ]}
                    aria-label={t("fields.aiOnFailure")}
                />
            </label>
            <ModelAndAgent config={config} set={set} />
        </div>
    );
}

type ExtractField = { name: string; kind: core.AiFieldKind; description: string; required: boolean };

export function AiExtractFields({ config, set }: Props) {
    const t = useTranslations("automations");
    const fields = list<ExtractField>(config.fields);
    const put = (next: ExtractField[]) => set({ fields: next });
    const change = (index: number, patch: Partial<ExtractField>) =>
        put(fields.map((one, at) => (at === index ? { ...one, ...patch } : one)));
    return (
        <div className="space-y-3">
            <TextField
                label={t("fields.aiExtractText")}
                hint={t("fields.aiExtractHint")}
                value={str(config.text)}
                onChange={(text) => set({ text })}
            />
            <div className="space-y-2" role="group" aria-label={t("fields.aiFields")}>
                <p className="text-sm">{t("fields.aiFields")}</p>
                {fields.map((field, index) => (
                    <div key={index} className="space-y-1 rounded-md bg-muted/40 p-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <Input
                                className="min-w-0 flex-1"
                                value={field.name}
                                maxLength={64}
                                placeholder={t("fields.aiFieldName")}
                                aria-label={t("fields.aiFieldName")}
                                onChange={(event) => change(index, { name: event.target.value })}
                            />
                            <div className="w-32 shrink-0">
                                <Select
                                    value={field.kind}
                                    onValueChange={(kind) => change(index, { kind: kind as core.AiFieldKind })}
                                    options={core.AI_FIELD_KINDS.map((kind) => ({
                                        value: kind,
                                        label: t(`fields.aiFieldKinds.${kind}`)
                                    }))}
                                    aria-label={t("fields.aiFieldKind")}
                                />
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={fields.length <= 1}
                                title={t("fields.aiFieldRemove")}
                                aria-label={t("fields.aiFieldRemove")}
                                onClick={() => put(fields.filter((_, at) => at !== index))}
                            >
                                <Trash2 aria-hidden="true" />
                            </Button>
                        </div>
                        <Input
                            value={field.description}
                            maxLength={300}
                            placeholder={t("fields.aiFieldDescription")}
                            aria-label={t("fields.aiFieldDescription")}
                            onChange={(event) => change(index, { description: event.target.value })}
                        />
                        <label className="flex items-center gap-2 text-xs">
                            <Checkbox
                                checked={field.required}
                                onChange={(event) => change(index, { required: event.target.checked })}
                            />
                            {t("fields.aiFieldRequired")}
                        </label>
                    </div>
                ))}
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={fields.length >= 30}
                    onClick={() =>
                        put([...fields, { name: "", kind: "text", description: "", required: false }])
                    }
                >
                    <Plus aria-hidden="true" />
                    {t("fields.aiFieldAdd")}
                </Button>
            </div>
            <ModelAndAgent config={config} set={set} />
        </div>
    );
}

/** Starting settings of each Polar step, as it lands on the canvas. */
export const POLAR_NODE_DEFAULTS: Record<string, () => Config> = {
    "core.aiWrite": () => ({ prompt: "", model: null, agentId: "", maxTokens: 1024 }),
    "core.aiAgent": () => ({
        task: "",
        model: null,
        agentId: "",
        maxSteps: 8,
        maxTokens: 16_000,
        timeoutSeconds: 120
    }),
    "core.aiDecide": () => ({
        input: "",
        instructions: "",
        cases: [
            { label: "", description: "" },
            { label: "", description: "" }
        ],
        onFailure: "error",
        model: null,
        agentId: ""
    }),
    "core.aiExtract": () => ({
        text: "",
        fields: [{ name: "", kind: "text", description: "", required: false }],
        model: null,
        agentId: ""
    })
};

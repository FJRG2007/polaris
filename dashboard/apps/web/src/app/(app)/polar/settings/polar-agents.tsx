"use client";

/**
 * Agents on Polar's settings: the person's own custom agents, as ChatGPT's
 * GPTs - a name, instructions, the skills and connectors it may use, whether
 * it reads the web and the model it answers on. Each starts a chat of its own
 * and can be a step of an automation.
 *
 * Every change is optimistic and put back when the server refuses it.
 */

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Bot, MessageSquarePlus, Pencil, Plus, Trash2 } from "lucide-react";
import {
    Button,
    Card,
    CardBody,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch,
    Textarea
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    AGENT_DESCRIPTION_MAX,
    AGENT_INSTRUCTIONS_MAX,
    AGENT_NAME_MAX,
    agentFieldError,
    agentInputSchema,
    type AgentInput,
    type AgentTextField,
    type AgentView
} from "@/lib/polar/agents/shared";
import { deleteAgentAction, saveAgentAction } from "./agents-actions";

/** A model the agent can be pinned to, as the picker lists it. */
export interface AgentModelOption {
    provider: string;
    model: string;
    label: string;
}

export interface AgentPicks {
    skills: string[];
    connectors: { id: string; name: string }[];
    models: AgentModelOption[];
}

const AUTOMATIC = "auto";
const keyOf = (provider: string, model: string) => `${provider}\u0000${model}`;

/** Where a chat with the agent starts. */
export function agentChatHref(id: string): string {
    return `/polar?new=1&agent=${encodeURIComponent(id)}`;
}

export function PolarAgents({
    initial,
    picks,
    readOnly
}: {
    initial: AgentView[];
    picks: AgentPicks;
    readOnly: boolean;
}) {
    const t = useTranslations("polar");
    const [rows, setRows] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<AgentView | "new" | null>(null);
    const [removing, setRemoving] = useState<AgentView | null>(null);

    async function remove(row: AgentView) {
        setError(null);
        setRemoving(null);
        setRows((current) => current.filter((entry) => entry.id !== row.id));
        const answer = await deleteAgentAction({ id: row.id });
        if (!answer.ok) {
            setRows((current) => [...current, row]);
            setError(answer.error);
        }
    }

    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{t("settings.agents.title")}</h2>
                    <p className="text-sm text-muted-foreground">{t("settings.agents.intro")}</p>
                </div>
                {!readOnly ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setEditing("new")}
                    >
                        <Plus className="h-3.5 w-3.5 shrink-0" />
                        {t("settings.agents.create")}
                    </Button>
                ) : null}
            </div>
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("settings.agents.empty")}</p>
            ) : (
                <Card>
                    <CardBody className="flex flex-col divide-y divide-border p-0">
                        {rows.map((row) => (
                            <div key={row.id} className="flex items-center gap-3 px-4 py-3">
                                <span
                                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
                                    aria-hidden="true"
                                >
                                    <Bot className="size-4 shrink-0" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium" title={row.name}>
                                        {row.name}
                                    </p>
                                    <p
                                        className="line-clamp-2 text-xs text-muted-foreground"
                                        title={row.description || row.instructions}
                                    >
                                        {row.description || row.instructions}
                                    </p>
                                </div>
                                <Button asChild size="sm" variant="outline" className="shrink-0">
                                    <Link href={agentChatHref(row.id)}>
                                        <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
                                        {t("settings.agents.chat")}
                                    </Link>
                                </Button>
                                {!readOnly ? (
                                    <>
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            aria-label={t("settings.agents.edit")}
                                            title={t("settings.agents.edit")}
                                            onClick={() => setEditing(row)}
                                        >
                                            <Pencil className="size-4 shrink-0" />
                                        </Button>
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            aria-label={t("settings.agents.delete")}
                                            title={t("settings.agents.delete")}
                                            onClick={() => setRemoving(row)}
                                        >
                                            <Trash2 className="size-4 shrink-0" />
                                        </Button>
                                    </>
                                ) : null}
                            </div>
                        ))}
                    </CardBody>
                </Card>
            )}
            <AgentEditor
                editing={editing}
                picks={picks}
                onClose={() => setEditing(null)}
                onSaved={(view) => {
                    setError(null);
                    setRows((current) =>
                        current.some((row) => row.id === view.id)
                            ? current.map((row) => (row.id === view.id ? view : row))
                            : [...current, view]
                    );
                    setEditing(null);
                }}
            />
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => !next && setRemoving(null)}
                name={removing?.name ?? ""}
                kind={t("settings.agents.kind")}
                description={t("settings.agents.removeHint")}
                onConfirm={() => removing && void remove(removing)}
            />
        </section>
    );
}

const EMPTY: AgentInput = {
    name: "",
    description: "",
    instructions: "",
    skills: [],
    connectorIds: [],
    web: true,
    choice: null
};

function valuesOf(editing: AgentView | "new" | null): AgentInput {
    if (!editing || editing === "new") return EMPTY;
    const { id: _id, ...values } = editing;
    return values;
}

function same(a: AgentInput, b: AgentInput): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function AgentEditor({
    editing,
    picks,
    onClose,
    onSaved
}: {
    editing: AgentView | "new" | null;
    picks: AgentPicks;
    onClose: () => void;
    onSaved: (view: AgentView) => void;
}) {
    const t = useTranslations("polar");
    const [values, setValues] = useState<AgentInput>(EMPTY);
    const [loadedFor, setLoadedFor] = useState<AgentView | "new" | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (editing !== loadedFor) {
        setLoadedFor(editing);
        setError(null);
        setValues(valuesOf(editing));
    }

    const checked = agentInputSchema.safeParse(values);
    const unchanged = editing !== null && editing !== "new" && same(values, valuesOf(editing));
    const complete = checked.success && !unchanged;
    const set = <K extends keyof AgentInput>(field: K, value: AgentInput[K]) =>
        setValues((current) => ({ ...current, [field]: value }));
    const toggleIn = (field: "skills" | "connectorIds", item: string, on: boolean) =>
        set(field, on ? [...values[field], item] : values[field].filter((entry) => entry !== item));

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!complete || pending || !checked.success) return;
        setPending(true);
        setError(null);
        const answer = await saveAgentAction({
            id: editing && editing !== "new" ? editing.id : null,
            agent: checked.data
        });
        setPending(false);
        if (answer.ok) onSaved(answer.value);
        else setError(answer.error);
    }

    const text: {
        key: AgentTextField;
        label: string;
        hint: string;
        max: number;
        required: boolean;
    }[] = [
        {
            key: "name",
            label: t("settings.agents.editor.name"),
            hint: t("settings.agents.editor.nameHint"),
            max: AGENT_NAME_MAX,
            required: true
        },
        {
            key: "description",
            label: t("settings.agents.editor.description"),
            hint: t("settings.agents.editor.descriptionHint"),
            max: AGENT_DESCRIPTION_MAX,
            required: false
        }
    ];
    const modelValue = values.choice
        ? keyOf(values.choice.provider, values.choice.model)
        : AUTOMATIC;
    const modelOptions = [
        { value: AUTOMATIC, label: t("settings.agents.editor.automatic") },
        ...picks.models.map((option) => ({
            value: keyOf(option.provider, option.model),
            label: option.label
        })),
        // A model the agent was pinned to that this person can no longer reach
        // still shows as what it is.
        ...(values.choice &&
        !picks.models.some(
            (option) =>
                option.provider === values.choice?.provider && option.model === values.choice?.model
        )
            ? [{ value: modelValue, label: values.choice.model }]
            : [])
    ];
    const instructionsProblem = agentFieldError("instructions", values.instructions);

    return (
        <Dialog open={editing !== null} onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {editing === "new"
                            ? t("settings.agents.editor.titleNew")
                            : t("settings.agents.editor.titleEdit")}
                    </DialogTitle>
                    <DialogDescription>{t("settings.agents.editor.body")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto overscroll-contain pr-1"
                    onSubmit={(event) => void submit(event)}
                >
                    {text.map((field) => {
                        const problem = agentFieldError(field.key, values[field.key]);
                        const id = `agent-${field.key}`;
                        return (
                            <div key={field.key} className="flex flex-col gap-1 text-sm">
                                <label htmlFor={id}>
                                    {field.label}
                                    {field.required ? " *" : ""}
                                </label>
                                <Input
                                    id={id}
                                    value={values[field.key]}
                                    maxLength={field.max}
                                    autoFocus={field.key === "name"}
                                    aria-invalid={problem ? true : undefined}
                                    onChange={(event) => set(field.key, event.target.value)}
                                />
                                <span
                                    className={
                                        problem
                                            ? "text-xs text-danger"
                                            : "text-xs text-muted-foreground"
                                    }
                                >
                                    {problem ? t("settings.agents.errors.too_long") : field.hint}
                                </span>
                            </div>
                        );
                    })}
                    <div className="flex flex-col gap-1 text-sm">
                        <label htmlFor="agent-instructions">
                            {t("settings.agents.editor.instructions")} *
                        </label>
                        <Textarea
                            id="agent-instructions"
                            rows={8}
                            value={values.instructions}
                            maxLength={AGENT_INSTRUCTIONS_MAX}
                            aria-invalid={instructionsProblem ? true : undefined}
                            className="font-mono text-xs"
                            onChange={(event) => set("instructions", event.target.value)}
                        />
                        <span
                            className={
                                instructionsProblem
                                    ? "text-xs text-danger"
                                    : "text-xs text-muted-foreground"
                            }
                        >
                            {instructionsProblem
                                ? t("settings.agents.errors.too_long")
                                : t("settings.agents.editor.instructionsHint")}
                        </span>
                    </div>
                    <div className="flex flex-col gap-1 text-sm">
                        <label htmlFor="agent-model">{t("settings.agents.editor.model")}</label>
                        <Select
                            id="agent-model"
                            value={modelValue}
                            options={modelOptions}
                            onValueChange={(value) => {
                                if (value === AUTOMATIC) return set("choice", null);
                                const [provider, model] = value.split("\u0000");
                                if (!provider || !model) return;
                                set("choice", {
                                    kind: "language",
                                    provider,
                                    model,
                                    intelligence: "balanced",
                                    payer: null
                                });
                            }}
                        />
                    </div>
                    <label className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0">
                            <span className="block">{t("settings.agents.editor.web")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("settings.agents.editor.webHint")}
                            </span>
                        </span>
                        <Switch
                            checked={values.web}
                            aria-label={t("settings.agents.editor.web")}
                            onChange={(on) => set("web", on)}
                        />
                    </label>
                    <PickList
                        title={t("settings.agents.editor.skills")}
                        hint={t("settings.agents.editor.picksHint")}
                        empty={t("settings.agents.editor.noSkills")}
                        items={picks.skills.map((name) => ({ id: name, label: name }))}
                        chosen={values.skills}
                        onToggle={(item, on) => toggleIn("skills", item, on)}
                    />
                    <PickList
                        title={t("settings.agents.editor.connectors")}
                        hint={t("settings.agents.editor.picksHint")}
                        empty={t("settings.agents.editor.noConnectors")}
                        items={picks.connectors.map((entry) => ({
                            id: entry.id,
                            label: entry.name
                        }))}
                        chosen={values.connectorIds}
                        onToggle={(item, on) => toggleIn("connectorIds", item, on)}
                    />
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
                            {t("settings.agents.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            aria-disabled={!complete || pending}
                            disabled={pending}
                        >
                            {t("settings.agents.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function PickList({
    title,
    hint,
    empty,
    items,
    chosen,
    onToggle
}: {
    title: string;
    hint: string;
    empty: string;
    items: { id: string; label: string }[];
    chosen: readonly string[];
    onToggle: (id: string, on: boolean) => void;
}) {
    return (
        <fieldset className="flex min-w-0 flex-col gap-1 text-sm">
            <legend>{title}</legend>
            <span className="text-xs text-muted-foreground">{items.length > 0 ? hint : empty}</span>
            {items.length > 0 ? (
                <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain rounded-md border border-border p-2">
                    {items.map((item) => {
                        const id = `pick-${title}-${item.id}`;
                        return (
                            <li key={item.id} className="flex min-w-0 items-center gap-2">
                                <Checkbox
                                    id={id}
                                    checked={chosen.includes(item.id)}
                                    onChange={(event) => onToggle(item.id, event.target.checked)}
                                />
                                <label htmlFor={id} className="min-w-0 truncate" title={item.label}>
                                    {item.label}
                                </label>
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </fieldset>
    );
}

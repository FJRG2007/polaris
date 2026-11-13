"use client";

/**
 * Agents on Polar's settings. Everything that works for the person is an agent
 * here: the ones that come with Polaris (Polar itself, Claude Code, Codex...),
 * edited for the account each signs in with and the models it may use, and
 * the person's own, as ChatGPT's GPTs - a name, instructions, what it runs on
 * (Polar or one of those tools), its account and its models, and on Polar the
 * skills, connectors and web it may use.
 *
 * Every change is optimistic and put back when the server refuses it.
 */

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Bot, Code2, MessageSquarePlus, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
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
import { AgentLogo } from "@/components/logos";
import { writeStored } from "@/lib/polar/stored";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AgentEngine } from "@/lib/polar/agents/composer-agents";
import {
    AGENT_DESCRIPTION_MAX,
    AGENT_INSTRUCTIONS_MAX,
    AGENT_NAME_MAX,
    agentFieldError,
    agentInputSchema,
    CODE_AGENT_STORAGE_KEY,
    customAgentKey,
    POLAR_ENGINE,
    type AgentInput,
    type AgentTextField,
    type AgentView,
    type AgentWork
} from "@/lib/polar/agents/shared";
import {
    accountLabel,
    accountValue,
    AgentWorkFields,
    modelOptionsFor,
    type AgentModelOption
} from "./agent-work-fields";
import { deleteAgentAction, saveAgentAction, saveAgentDefaultAction } from "./agents-actions";

export type { AgentModelOption } from "./agent-work-fields";

export interface AgentPicks {
    skills: string[];
    connectors: { id: string; name: string }[];
    /** Polar's own models, for Polar and a tool that runs on its keys. */
    models: AgentModelOption[];
    /** The coding tools an agent can run on, with their accounts and models. */
    engines: AgentEngine[];
}

/** Where a chat with the agent starts. */
/** Included tools shown before "Show all": Polar and the first few, so the
 *  list does not push the person's own agents off the screen. */
const COLLAPSED_TOOLS = 5;

export function agentChatHref(id: string): string {
    return `/polar?new=1&agent=${encodeURIComponent(id)}`;
}

/** Where a new Code task starts; the agent is what Code opens on. */
const CODE_TASK_HREF = "/polar?session=new";

type Translate = ReturnType<typeof useTranslations>;

/** One line on what an agent works with: its account and preferred model. */
function workSummary(
    work: AgentWork,
    engines: readonly AgentEngine[],
    polarModels: readonly AgentModelOption[],
    t: Translate
): string {
    const engine = engines.find((entry) => entry.engine === work.engine);
    const account = work.account
        ? engine?.accounts.find((entry) => accountValue(entry) === work.account)
        : null;
    const accountText =
        work.engine === POLAR_ENGINE
            ? null
            : work.account
              ? account
                  ? accountLabel(account, t)
                  : t("settings.agents.work.accountGone")
              : t("settings.agents.work.anyAccount");
    const first = work.models[0];
    const firstLabel = first
        ? (modelOptionsFor(work.engine, engines, polarModels).find(
              (option) => option.provider === first.provider && option.model === first.model
          )?.label ?? first.model)
        : null;
    const modelText =
        engine?.modelSource === "none"
            ? t("settings.agents.work.ownModelShort")
            : firstLabel
              ? work.models.length > 1
                  ? t("settings.agents.work.modelsCount", {
                        model: firstLabel,
                        count: work.models.length - 1
                    })
                  : firstLabel
              : t("settings.agents.work.anyModelShort");
    return [accountText, modelText].filter(Boolean).join(" - ");
}

function EngineMark({ engine, name }: { engine: string; name: string }) {
    return (
        <span
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
            aria-hidden="true"
        >
            {engine === POLAR_ENGINE ? (
                <Sparkles className="size-4 shrink-0" />
            ) : (
                <AgentLogo id={engine} label={name} className="size-4 shrink-0" />
            )}
        </span>
    );
}

export function PolarAgents({
    initial,
    defaults,
    picks,
    readOnly
}: {
    initial: AgentView[];
    /** The saved settings of the agents that come with Polaris, by engine. */
    defaults: AgentWork[];
    picks: AgentPicks;
    readOnly: boolean;
}) {
    const t = useTranslations("polar");
    const [rows, setRows] = useState(initial);
    const [works, setWorks] = useState(defaults);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<AgentView | "new" | null>(null);
    const [tuning, setTuning] = useState<{ engine: string; name: string } | null>(null);
    const [allTools, setAllTools] = useState(false);
    const [removing, setRemoving] = useState<AgentView | null>(null);

    const workOf = (engine: string): AgentWork =>
        works.find((entry) => entry.engine === engine) ?? {
            engine,
            account: null,
            models: [],
            modelPolicy: "preferred"
        };
    const builtIns = [
        { engine: POLAR_ENGINE, name: "Polar" },
        ...picks.engines.map((entry) => ({ engine: entry.engine, name: entry.name }))
    ];
    const engineName = (engine: string) =>
        builtIns.find((entry) => entry.engine === engine)?.name ?? engine;

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

    async function saveWork(next: AgentWork): Promise<string | null> {
        const before = works;
        setWorks((current) => [...current.filter((entry) => entry.engine !== next.engine), next]);
        const answer = await saveAgentDefaultAction(next);
        if (answer.ok) return null;
        setWorks(before);
        return answer.error;
    }

    return (
        <section className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{t("settings.agents.builtInTitle")}</h2>
                    <p className="text-sm text-muted-foreground">{t("settings.agents.builtInIntro")}</p>
                </div>
                <Card>
                    <CardBody className="flex flex-col divide-y divide-border p-0">
                        {(allTools ? builtIns : builtIns.slice(0, COLLAPSED_TOOLS)).map((entry) => (
                            <div key={entry.engine} className="flex items-center gap-3 px-4 py-3">
                                <EngineMark engine={entry.engine} name={entry.name} />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium" title={entry.name}>
                                        {entry.name}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {workSummary(workOf(entry.engine), picks.engines, picks.models, t)}
                                    </p>
                                </div>
                                {!readOnly ? (
                                    <Button
                                        type="button"
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label={t("settings.agents.editNamed", { name: entry.name })}
                                        title={t("settings.agents.edit")}
                                        onClick={() => setTuning(entry)}
                                    >
                                        <Pencil className="size-4 shrink-0" />
                                    </Button>
                                ) : null}
                            </div>
                        ))}
                        {builtIns.length > COLLAPSED_TOOLS ? (
                            <button
                                type="button"
                                className="px-4 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
                                aria-expanded={allTools}
                                onClick={() => setAllTools((current) => !current)}
                            >
                                {allTools
                                    ? t("settings.agents.showFewer")
                                    : t("settings.agents.showAll", { count: builtIns.length })}
                            </button>
                        ) : null}
                    </CardBody>
                </Card>
            </div>
            <div className="flex flex-col gap-3">
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
                            {rows.map((row) => {
                                const onPolar = row.engine === POLAR_ENGINE;
                                return (
                                    <div key={row.id} className="flex items-center gap-3 px-4 py-3">
                                        {onPolar ? (
                                            <span
                                                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
                                                aria-hidden="true"
                                            >
                                                <Bot className="size-4 shrink-0" />
                                            </span>
                                        ) : (
                                            <EngineMark engine={row.engine} name={engineName(row.engine)} />
                                        )}
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium" title={row.name}>
                                                {row.name}
                                            </p>
                                            <p
                                                className="truncate text-xs text-muted-foreground"
                                                title={row.description || row.instructions}
                                            >
                                                {row.description || row.instructions}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {[
                                                    // Only worth saying when it is not the usual: an
                                                    // agent on Polar is what anybody expects.
                                                    onPolar
                                                        ? null
                                                        : t("settings.agents.runsOn", {
                                                              engine: engineName(row.engine)
                                                          }),
                                                    workSummary(row, picks.engines, picks.models, t)
                                                ]
                                                    .filter(Boolean)
                                                    .join(" - ")}
                                            </p>
                                        </div>
                                        <Button asChild size="sm" variant="outline" className="shrink-0">
                                            {onPolar ? (
                                                <Link href={agentChatHref(row.id)}>
                                                    <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
                                                    {t("settings.agents.chat")}
                                                </Link>
                                            ) : (
                                                <Link
                                                    href={CODE_TASK_HREF}
                                                    onClick={() =>
                                                        writeStored(
                                                            CODE_AGENT_STORAGE_KEY,
                                                            customAgentKey(row.id)
                                                        )
                                                    }
                                                >
                                                    <Code2 className="h-3.5 w-3.5 shrink-0" />
                                                    {t("settings.agents.newTask")}
                                                </Link>
                                            )}
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
                                );
                            })}
                        </CardBody>
                    </Card>
                )}
            </div>
            <WorkEditor
                tuning={tuning}
                initial={tuning ? workOf(tuning.engine) : null}
                picks={picks}
                onClose={() => setTuning(null)}
                onSave={saveWork}
            />
            <AgentEditor
                editing={editing}
                picks={picks}
                engineName={engineName}
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

/** The account and models of an agent that comes with Polaris. */
function WorkEditor({
    tuning,
    initial,
    picks,
    onClose,
    onSave
}: {
    tuning: { engine: string; name: string } | null;
    initial: AgentWork | null;
    picks: AgentPicks;
    onClose: () => void;
    onSave: (work: AgentWork) => Promise<string | null>;
}) {
    const t = useTranslations("polar");
    const [values, setValues] = useState<AgentWork | null>(null);
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const engine = tuning?.engine ?? null;
    if (engine !== loadedFor) {
        setLoadedFor(engine);
        setError(null);
        setValues(initial);
    }
    const unchanged = values === null || JSON.stringify(values) === JSON.stringify(initial);

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!values || unchanged || pending) return;
        setPending(true);
        setError(null);
        const refused = await onSave(values);
        setPending(false);
        if (refused) setError(refused);
        else onClose();
    }

    return (
        <Dialog open={tuning !== null} onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{tuning?.name ?? ""}</DialogTitle>
                    <DialogDescription>{t("settings.agents.work.body")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto overscroll-contain pr-1"
                    onSubmit={(event) => void submit(event)}
                >
                    {values ? (
                        <AgentWorkFields
                            value={values}
                            onChange={setValues}
                            engines={picks.engines}
                            polarModels={picks.models}
                            idPrefix="builtin"
                        />
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
                            {t("settings.agents.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={unchanged || pending} disabled={pending}>
                            {t("settings.agents.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

const EMPTY: AgentInput = {
    name: "",
    description: "",
    instructions: "",
    skills: [],
    connectorIds: [],
    web: true,
    choice: null,
    engine: POLAR_ENGINE,
    account: null,
    models: [],
    modelPolicy: "preferred"
};

function valuesOf(editing: AgentView | "new" | null): AgentInput {
    if (!editing || editing === "new") return EMPTY;
    const { id: _id, ...values } = editing;
    return values;
}

/** The fields that are the agent's, without `choice`, which the server
 *  writes from the first of the models. */
function same(a: AgentInput, b: AgentInput): boolean {
    const { choice: _a, ...left } = a;
    const { choice: _b, ...right } = b;
    return JSON.stringify(left) === JSON.stringify(right);
}

function AgentEditor({
    editing,
    picks,
    engineName,
    onClose,
    onSaved
}: {
    editing: AgentView | "new" | null;
    picks: AgentPicks;
    engineName: (engine: string) => string;
    onClose: () => void;
    onSaved: (view: AgentView) => void;
}) {
    const t = useTranslations("polar");
    const [values, setValues] = useState<AgentInput>(EMPTY);
    const [loadedFor, setLoadedFor] = useState<AgentView | "new" | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [advanced, setAdvanced] = useState(false);

    if (editing !== loadedFor) {
        const loaded = valuesOf(editing);
        setLoadedFor(editing);
        setError(null);
        setValues(loaded);
        // An agent already set to a coding tool shows where it works; a new
        // one starts on Polar and nobody has to decide.
        setAdvanced(loaded.engine !== POLAR_ENGINE);
    }

    const checked = agentInputSchema.safeParse(values);
    const unchanged = editing !== null && editing !== "new" && same(values, valuesOf(editing));
    const complete = checked.success && !unchanged;
    const onPolar = values.engine === POLAR_ENGINE;
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
    const engineOptions = [
        { value: POLAR_ENGINE, label: "Polar" },
        ...picks.engines.map((entry) => ({ value: entry.engine, label: entry.name })),
        // A tool no longer offered here still reads as what it was.
        ...(!onPolar && !picks.engines.some((entry) => entry.engine === values.engine)
            ? [{ value: values.engine, label: engineName(values.engine) }]
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
                    {!advanced ? (
                        <button
                            type="button"
                            className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                            onClick={() => setAdvanced(true)}
                        >
                            {t("settings.agents.editor.engineMore")}
                        </button>
                    ) : (
                    <div className="flex flex-col gap-1 text-sm">
                        <label htmlFor="agent-engine">{t("settings.agents.editor.engine")}</label>
                        <Select
                            id="agent-engine"
                            value={values.engine}
                            options={engineOptions}
                            onValueChange={(engine) =>
                                // Another tool has other accounts and models.
                                setValues((current) =>
                                    current.engine === engine
                                        ? current
                                        : { ...current, engine, account: null, models: [], modelPolicy: "preferred" }
                                )
                            }
                        />
                        <span className="text-xs text-muted-foreground">
                            {onPolar
                                ? t("settings.agents.editor.enginePolarHint")
                                : t("settings.agents.editor.engineToolHint")}
                        </span>
                    </div>
                    )}
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
                    <AgentWorkFields
                        value={values}
                        onChange={(work) => setValues((current) => ({ ...current, ...work }))}
                        engines={picks.engines}
                        polarModels={picks.models}
                        idPrefix="agent"
                    />
                    {onPolar ? (
                        <>
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
                        </>
                    ) : null}
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

"use client";

/**
 * One automation, laid out as it runs: WHEN any of these happens, IF these hold,
 * THEN these steps, in order - a column of cards joined by a line, each card
 * one node, each added, removed and moved where it sits.
 *
 * Checked as it is typed, against the same schema and the same device checks
 * the server runs, so a problem is said under the field it is about. A field not
 * filled in yet is unfinished rather than wrong: it carries a `*`, Save waits,
 * and only pressing Save anyway says which ones are missing.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Filter, Loader2, Play, Plus, Zap } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    SegmentedControl,
    Select,
    Skeleton,
    Switch,
    Textarea,
    cn
} from "@polaris/ui";
import { RunLog } from "./run-log";
import * as actions from "./actions";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import * as auto from "../../lib/automation-kinds";
import * as words from "../../lib/automation-words";
import type { DeviceView } from "../../lib/device-kinds";
import { dropAutomationsCache } from "./cache";
import * as fields from "./flow-fields";

const { runAction } = hostUi.runAction;
const { useDisplayFormat } = hostUi.displayFormat;

/** An automation while it is being edited: the input the server takes. */
export type Draft = auto.AutomationInput;

type Tab = "flow" | "runs";

/** Messages that mean "not filled in yet" rather than "wrong", which wait for a
 *  press of Save before they are said. */
const UNFINISHED = new Set([
    "automations.errors.name",
    "automations.errors.device",
    "automations.errors.state",
    "automations.errors.number",
    "automations.errors.message",
    "automations.errors.automation",
    "automations.errors.noTrigger",
    "automations.errors.noStep",
    "automations.errors.emptyGroup",
    "automations.errors.days"
]);

function pathKey(path: readonly (string | number)[]): string {
    return path.join(".");
}

function move<T>(list: readonly T[], index: number, by: number): T[] {
    const next = [...list];
    const target = index + by;
    if (target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
}

/** A new automation as a template starts it. */
export function startingDraft(
    template: string | null,
    device: DeviceView | undefined,
    placeId: string,
    timeZone: string,
    t: ReturnType<typeof usePlacesT>
): Draft {
    const base = { enabled: true, placeId };
    if (template === "autoOff") {
        const planned = device ? auto.autoOffDefinition(device, 30, timeZone) : null;
        return {
            ...base,
            name: device
                ? words.autoOffName(device, 30, t)
                : t("automations.templates.autoOff.title"),
            definition: planned ?? {
                timeZone,
                triggers: [
                    {
                        ...(auto.blankTrigger("stays") as Extract<auto.Trigger, { kind: "stays" }>),
                        is: "on"
                    }
                ],
                conditions: { match: "all", groups: [] },
                actions: [auto.blankStep("device")]
            }
        };
    }
    if (template === "schedule") {
        return {
            ...base,
            name: t("automations.templates.schedule.title"),
            definition: auto.scheduleDefinition(
                device?.id ?? "",
                "07:00",
                "23:00",
                [...auto.WEEKDAYS],
                timeZone
            )
        };
    }
    if (template === "follow") {
        return {
            ...base,
            name: t("automations.templates.follow.title"),
            definition: auto.followDefinition(timeZone)
        };
    }
    return { ...base, name: "", definition: auto.blankDefinition(timeZone) };
}

export function AutomationEditor({
    automationId,
    template,
    deviceId,
    canManage,
    canControl,
    initialTab
}: {
    automationId: string | null;
    template: string | null;
    deviceId: string | null;
    canManage: boolean;
    canControl: boolean;
    initialTab: Tab;
}) {
    const t = usePlacesT();
    const format = useDisplayFormat();
    const router = useRouter();
    const [loaded, setLoaded] = useState<{
        automation: auto.AutomationView | null;
        runs: auto.RunView[];
        context: actions.EditorContext;
    } | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [saved, setSaved] = useState<string>("");
    const [attempted, setAttempted] = useState(false);
    const [serverIssues, setServerIssues] = useState<actions.AutomationFieldIssue[]>([]);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [saving, setSaving] = useState(false);
    const inFlight = useRef({ save: false, run: false });
    const [running, setRunning] = useState(false);
    const [tab, setTab] = useState<Tab>(automationId ? initialTab : "flow");
    const [refreshKey, setRefreshKey] = useState(0);
    const readOnly = !canManage;

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await runAction(
                () => actions.getAutomationAction(automationId),
                setError
            );
            if (cancelled || !result) return;
            if (result.error || !result.context) {
                setError(result.error ?? t("refusals.failed"));
                return;
            }
            const context = result.context;
            const next: Draft = result.automation
                ? {
                      name: result.automation.name,
                      enabled: result.automation.enabled,
                      placeId: result.automation.placeId,
                      definition: result.automation.definition
                  }
                : startingDraft(
                      template,
                      context.devices.find((device) => device.id === deviceId),
                      context.placeId,
                      auto.readerZone(format.preferences.timeZone),
                      t
                  );
            setLoaded({ automation: result.automation ?? null, runs: result.runs ?? [], context });
            setDraft(next);
            // A template is a start, not something already saved: it is dirty
            // from the first moment so Save is there to press.
            setSaved(result.automation ? JSON.stringify(auto.normalizeAutomationInput(next)) : "");
        })();
        return () => {
            cancelled = true;
        };
        // Loaded once per automation; the reader's zone and words at that moment
        // are what a template starts from.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [automationId]);

    const devices = loaded?.context.devices ?? [];
    const byId = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices]);
    const lookup = useCallback<words.DeviceLookup>((id) => byId.get(id), [byId]);
    const siblings = useMemo(
        () => (loaded?.context.siblings ?? []).filter((sibling) => sibling.id !== automationId),
        [loaded, automationId]
    );
    const automationName = useCallback(
        (id: string) => loaded?.context.siblings.find((sibling) => sibling.id === id)?.name,
        [loaded]
    );

    const normalized = useMemo(
        () => (draft ? auto.normalizeAutomationInput(draft) : null),
        [draft]
    );
    const dirty = normalized !== null && JSON.stringify(normalized) !== saved;

    /** Every complaint about the draft as it stands: the schema's, then - once
     *  the shape is right - the ones about the devices it names. */
    const issues = useMemo<{ path: readonly (string | number)[]; message: string }[]>(() => {
        if (!normalized) return [];
        const parsed = auto.automationInputSchema.safeParse(normalized);
        if (!parsed.success)
            return parsed.error.issues.map((issue) => ({
                path: issue.path,
                message: issue.message
            }));
        return auto.deviceIssues(parsed.data.definition, devices, {
            automationIds: loaded?.context.siblings.map((sibling) => sibling.id) ?? [],
            selfId: automationId
        });
    }, [normalized, devices, loaded, automationId]);

    const issueLookup = useMemo<fields.IssueLookup>(() => {
        const found = new Map<string, string>();
        for (const issue of issues) {
            const key = pathKey(issue.path);
            if (found.has(key)) continue;
            if (!attempted && UNFINISHED.has(issue.message)) continue;
            found.set(key, words.issueText(issue.message, t));
        }
        for (const issue of serverIssues)
            if (!found.has(pathKey(issue.path))) found.set(pathKey(issue.path), issue.message);
        return (path) => found.get(pathKey(path));
    }, [issues, serverIssues, attempted, t]);

    useEffect(() => {
        if (!dirty || readOnly) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty, readOnly]);

    const edit = (change: (current: Draft) => Draft) => {
        setServerIssues([]);
        setNotice("");
        setDraft((current) => (current ? change(current) : current));
    };
    const editDefinition = (
        change: (current: auto.AutomationDefinition) => auto.AutomationDefinition
    ) => edit((current) => ({ ...current, definition: change(current.definition) }));

    const save = async () => {
        if (!draft || !normalized || readOnly) return;
        setAttempted(true);
        if (issues.length > 0 || !dirty || inFlight.current.save) return;
        inFlight.current.save = true;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => actions.saveAutomationAction(automationId, normalized),
            setError
        );
        inFlight.current.save = false;
        setSaving(false);
        if (!result) return;
        if (result.issues) setServerIssues(result.issues);
        if (result.error || !result.automation) {
            setError(result.error ?? t("refusals.failed"));
            return;
        }
        dropAutomationsCache();
        const stored: Draft = {
            name: result.automation.name,
            enabled: result.automation.enabled,
            placeId: result.automation.placeId,
            definition: result.automation.definition
        };
        setDraft(stored);
        setSaved(JSON.stringify(auto.normalizeAutomationInput(stored)));
        setLoaded((current) =>
            current ? { ...current, automation: result.automation ?? null } : current
        );
        setAttempted(false);
        setNotice(t("automations.editor.saved"));
        if (!automationId) router.replace(`/places/devices/automations/${result.automation.id}`);
    };

    const runNow = async () => {
        if (!automationId || inFlight.current.run) return;
        inFlight.current.run = true;
        setRunning(true);
        setError("");
        const result = await runAction(() => actions.runAutomationAction(automationId), setError);
        inFlight.current.run = false;
        setRunning(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setTab("runs");
        setRefreshKey((key) => key + 1);
    };

    const header = (
        <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="ghost" className="px-2">
                <Link href="/places/devices/automations">
                    <ArrowLeft className="size-4 shrink-0" />
                    {t("automations.editor.back")}
                </Link>
            </Button>
            <span className="flex-1" />
            {automationId && loaded && (
                <SegmentedControl<Tab>
                    size="sm"
                    value={tab}
                    onValueChange={setTab}
                    aria-label={t("automations.editor.view")}
                    options={[
                        { value: "flow", label: t("automations.editor.flow") },
                        { value: "runs", label: t("automations.editor.runs") }
                    ]}
                />
            )}
        </div>
    );

    if (!draft || !loaded) {
        return (
            <div className="flex flex-col gap-4">
                {header}
                {error ? (
                    <p
                        role="alert"
                        className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                    >
                        {error}
                    </p>
                ) : (
                    <div className="flex flex-col gap-3" aria-busy="true">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-24 w-full" />
                        <Skeleton className="h-24 w-full" />
                        <Skeleton className="h-24 w-full" />
                    </div>
                )}
            </div>
        );
    }

    const definition = draft.definition;
    const watchedDevices = devices.filter(fields.watchable);
    const sensors = devices.filter((device) => device.kind === "sensor");
    const operableDevices = canControl ? devices.filter(fields.operable) : [];
    const blocked = issues.length > 0 || !dirty;

    return (
        <fields.IssueProvider value={issueLookup}>
            <div className="flex flex-col gap-4">
                {header}

                <div className="flex flex-wrap items-end gap-3">
                    <fields.Field
                        label={t("automations.editor.name")}
                        path={["name"]}
                        required
                        className="min-w-[12rem] flex-1"
                    >
                        {(id, invalid) => (
                            <Input
                                id={id}
                                value={draft.name}
                                maxLength={auto.LIMITS.name}
                                disabled={readOnly}
                                placeholder={t("automations.editor.namePlaceholder")}
                                aria-invalid={invalid || undefined}
                                onChange={(event) =>
                                    edit((current) => ({ ...current, name: event.target.value }))
                                }
                            />
                        )}
                    </fields.Field>
                    <label className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                            checked={draft.enabled}
                            disabled={readOnly}
                            aria-label={t("automations.editor.enabled")}
                            onChange={(enabled) => edit((current) => ({ ...current, enabled }))}
                        />
                        {draft.enabled ? t("automations.editor.on") : t("automations.editor.off")}
                    </label>
                    {!readOnly && (
                        <>
                            {automationId && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={running || dirty || !draft.enabled}
                                    title={dirty ? t("automations.editor.saveFirst") : undefined}
                                    onClick={() => void runNow()}
                                >
                                    {running ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        <Play className="size-4 shrink-0" />
                                    )}
                                    {t("automations.list.run")}
                                </Button>
                            )}
                            <Button
                                size="sm"
                                aria-disabled={blocked || saving || undefined}
                                className={cn(blocked && "opacity-60")}
                                onClick={() => void save()}
                            >
                                {saving && <Loader2 className="size-4 animate-spin" />}
                                {t("common.save")}
                            </Button>
                        </>
                    )}
                </div>

                {error && (
                    <p
                        role="alert"
                        className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                    >
                        {error}
                    </p>
                )}
                {notice && !dirty && (
                    <p role="status" className="text-xs text-muted-foreground">
                        {notice}
                    </p>
                )}
                {readOnly && (
                    <p className="text-xs text-muted-foreground">
                        {t("automations.editor.readOnly")}
                    </p>
                )}

                {tab === "runs" && loaded.automation ? (
                    <RunLog
                        automation={loaded.automation}
                        initial={loaded.runs}
                        lookup={lookup}
                        automationName={automationName}
                        refreshKey={refreshKey}
                    />
                ) : (
                    <ol className="flex flex-col">
                        <Stage
                            icon={<Zap className="size-4" />}
                            title={t("automations.editor.when")}
                            hint={t("automations.editor.whenHint")}
                            issue={attempted ? issueLookup(["definition", "triggers"]) : undefined}
                        >
                            {definition.triggers.map((trigger, index) => (
                                <TriggerCard
                                    key={trigger.id}
                                    trigger={trigger}
                                    path={["definition", "triggers", index]}
                                    devices={watchedDevices}
                                    sensors={sensors}
                                    byId={byId}
                                    disabled={readOnly}
                                    onChange={(next) =>
                                        editDefinition((current) => ({
                                            ...current,
                                            triggers: current.triggers.map((entry, at) =>
                                                at === index ? next : entry
                                            )
                                        }))
                                    }
                                    onRemove={() =>
                                        editDefinition((current) => ({
                                            ...current,
                                            triggers: current.triggers.filter(
                                                (_, at) => at !== index
                                            )
                                        }))
                                    }
                                    onUp={
                                        index > 0
                                            ? () =>
                                                  editDefinition((current) => ({
                                                      ...current,
                                                      triggers: move(current.triggers, index, -1)
                                                  }))
                                            : undefined
                                    }
                                    onDown={
                                        index < definition.triggers.length - 1
                                            ? () =>
                                                  editDefinition((current) => ({
                                                      ...current,
                                                      triggers: move(current.triggers, index, 1)
                                                  }))
                                            : undefined
                                    }
                                />
                            ))}
                            {!readOnly && definition.triggers.length < auto.LIMITS.triggers && (
                                <AddMenu
                                    label={t("automations.editor.addTrigger")}
                                    options={auto.TRIGGER_KINDS.map((kind) => ({
                                        value: kind,
                                        label: words.triggerKindText(kind, t)
                                    }))}
                                    onPick={(kind) =>
                                        editDefinition((current) => ({
                                            ...current,
                                            triggers: [
                                                ...current.triggers,
                                                auto.blankTrigger(kind as auto.TriggerKind)
                                            ]
                                        }))
                                    }
                                />
                            )}
                        </Stage>

                        <Stage
                            icon={<Filter className="size-4" />}
                            title={t("automations.editor.if")}
                            hint={
                                definition.conditions.groups.length === 0
                                    ? t("automations.editor.ifEmpty")
                                    : t("automations.editor.ifHint")
                            }
                        >
                            {definition.conditions.groups.length > 1 && (
                                <MatchPicker
                                    value={definition.conditions.match}
                                    disabled={readOnly}
                                    label={t("automations.editor.groupsMatch")}
                                    onChange={(match) =>
                                        editDefinition((current) => ({
                                            ...current,
                                            conditions: { ...current.conditions, match }
                                        }))
                                    }
                                    allLabel={t("automations.editor.allGroups")}
                                    anyLabel={t("automations.editor.anyGroup")}
                                />
                            )}
                            {definition.conditions.groups.map((group, groupIndex) => (
                                <ConditionGroupCard
                                    key={group.id}
                                    group={group}
                                    path={["definition", "conditions", "groups", groupIndex]}
                                    devices={watchedDevices}
                                    sensors={sensors}
                                    byId={byId}
                                    disabled={readOnly}
                                    attempted={attempted}
                                    onChange={(next) =>
                                        editDefinition((current) => ({
                                            ...current,
                                            conditions: {
                                                ...current.conditions,
                                                groups: current.conditions.groups.map(
                                                    (entry, at) =>
                                                        at === groupIndex ? next : entry
                                                )
                                            }
                                        }))
                                    }
                                    onRemove={() =>
                                        editDefinition((current) => ({
                                            ...current,
                                            conditions: {
                                                ...current.conditions,
                                                groups: current.conditions.groups.filter(
                                                    (_, at) => at !== groupIndex
                                                )
                                            }
                                        }))
                                    }
                                />
                            ))}
                            {!readOnly &&
                                definition.conditions.groups.length < auto.LIMITS.groups && (
                                    <AddMenu
                                        label={t("automations.editor.addCondition")}
                                        options={auto.CONDITION_KINDS.map((kind) => ({
                                            value: kind,
                                            label: words.conditionKindText(kind, t)
                                        }))}
                                        onPick={(kind) =>
                                            editDefinition((current) => ({
                                                ...current,
                                                conditions: {
                                                    ...current.conditions,
                                                    groups: [
                                                        ...current.conditions.groups,
                                                        {
                                                            id: auto.nodeIdOf(),
                                                            match: "all",
                                                            items: [
                                                                auto.blankCondition(
                                                                    kind as auto.ConditionKind
                                                                )
                                                            ]
                                                        }
                                                    ]
                                                }
                                            }))
                                        }
                                    />
                                )}
                        </Stage>

                        <Stage
                            icon={<Play className="size-4" />}
                            title={t("automations.editor.then")}
                            hint={t("automations.editor.thenHint")}
                            issue={attempted ? issueLookup(["definition", "actions"]) : undefined}
                            last
                        >
                            {definition.actions.map((step, index) => (
                                <StepCard
                                    key={step.id}
                                    number={index + 1}
                                    step={step}
                                    path={["definition", "actions", index]}
                                    watched={watchedDevices}
                                    operable={operableDevices}
                                    canControl={canControl}
                                    byId={byId}
                                    siblings={siblings}
                                    disabled={readOnly}
                                    onChange={(next) =>
                                        editDefinition((current) => ({
                                            ...current,
                                            actions: current.actions.map((entry, at) =>
                                                at === index ? next : entry
                                            )
                                        }))
                                    }
                                    onRemove={() =>
                                        editDefinition((current) => ({
                                            ...current,
                                            actions: current.actions.filter((_, at) => at !== index)
                                        }))
                                    }
                                    onUp={
                                        index > 0
                                            ? () =>
                                                  editDefinition((current) => ({
                                                      ...current,
                                                      actions: move(current.actions, index, -1)
                                                  }))
                                            : undefined
                                    }
                                    onDown={
                                        index < definition.actions.length - 1
                                            ? () =>
                                                  editDefinition((current) => ({
                                                      ...current,
                                                      actions: move(current.actions, index, 1)
                                                  }))
                                            : undefined
                                    }
                                />
                            ))}
                            {!readOnly && definition.actions.length < auto.LIMITS.steps && (
                                <AddMenu
                                    label={t("automations.editor.addStep")}
                                    options={auto.STEP_KINDS.map((kind) => ({
                                        value: kind,
                                        label: words.stepKindText(kind, t)
                                    }))}
                                    onPick={(kind) =>
                                        editDefinition((current) => ({
                                            ...current,
                                            actions: [
                                                ...current.actions,
                                                auto.blankStep(kind as auto.StepKind)
                                            ]
                                        }))
                                    }
                                />
                            )}
                        </Stage>
                        <li className="pt-2 text-[0.6875rem] text-foreground-subtle">
                            {t("automations.editor.zone", { zone: definition.timeZone })}
                            {loaded.automation?.ownerName
                                ? ` ${t("automations.editor.runsAs", { name: loaded.automation.ownerName })}`
                                : ""}
                        </li>
                    </ol>
                )}
            </div>
        </fields.IssueProvider>
    );
}

/** One of WHEN, IF and THEN: a heading on the line, its cards, and the line
 *  carried down to the next. */
function Stage({
    icon,
    title,
    hint,
    issue,
    last,
    children
}: {
    icon: ReactNode;
    title: string;
    hint: string;
    issue?: string;
    last?: boolean;
    children: ReactNode;
}) {
    return (
        <li className="relative flex gap-3 pb-5">
            {!last && (
                <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-[0.9375rem] top-8 w-px bg-border"
                />
            )}
            <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                {icon}
            </span>
            <section className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <header className="flex flex-wrap items-baseline gap-x-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wide">{title}</h2>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                </header>
                {children}
                {issue && <p className="text-xs text-danger">{issue}</p>}
            </section>
        </li>
    );
}

function AddMenu({
    label,
    options,
    onPick
}: {
    label: string;
    options: readonly { value: string; label: string }[];
    onPick: (value: string) => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="self-start border-dashed">
                    <Plus className="size-4 shrink-0" />
                    {label}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                {options.map((option) => (
                    <DropdownMenuItem key={option.value} onSelect={() => onPick(option.value)}>
                        {option.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function MatchPicker({
    value,
    onChange,
    label,
    allLabel,
    anyLabel,
    disabled
}: {
    value: "all" | "any";
    onChange: (value: "all" | "any") => void;
    label: string;
    allLabel: string;
    anyLabel: string;
    disabled?: boolean;
}) {
    return (
        <Select
            value={value}
            disabled={disabled}
            aria-label={label}
            className="w-auto self-start"
            options={[
                { value: "all", label: allLabel },
                { value: "any", label: anyLabel }
            ]}
            onValueChange={(next) => onChange(next as "all" | "any")}
        />
    );
}

function KindPicker<K extends string>({
    value,
    kinds: offered,
    label,
    text,
    disabled,
    onChange
}: {
    value: K;
    kinds: readonly K[];
    label: string;
    text: (kind: K) => string;
    disabled?: boolean;
    onChange: (kind: K) => void;
}) {
    return (
        <Select
            value={value}
            disabled={disabled}
            aria-label={label}
            className="h-7 w-auto max-w-full border-transparent bg-transparent px-1 font-medium hover:border-border"
            options={offered.map((kind) => ({ value: kind, label: text(kind) }))}
            onValueChange={(next) => onChange(next as K)}
        />
    );
}

function TriggerCard({
    trigger,
    path,
    devices,
    sensors,
    byId,
    disabled,
    onChange,
    onRemove,
    onUp,
    onDown
}: {
    trigger: auto.Trigger;
    path: (string | number)[];
    devices: DeviceView[];
    sensors: DeviceView[];
    byId: ReadonlyMap<string, DeviceView>;
    disabled: boolean;
    onChange: (trigger: auto.Trigger) => void;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
}) {
    const t = usePlacesT();
    const device = "deviceId" in trigger ? byId.get(trigger.deviceId) : undefined;
    const pickDevice = (next: DeviceView) => {
        if (!("deviceId" in trigger)) return;
        const attribute = auto.attributesFor(next.kind)[0] ?? "state";
        if (trigger.kind === "change")
            onChange({ ...trigger, deviceId: next.id, attribute, from: "", to: "" });
        else if (trigger.kind === "stays")
            onChange({ ...trigger, deviceId: next.id, attribute, is: "" });
        else onChange({ ...trigger, deviceId: next.id });
    };
    return (
        <fields.NodeCard
            kind={
                <KindPicker
                    value={trigger.kind}
                    kinds={auto.TRIGGER_KINDS}
                    label={t("automations.editor.triggerKind")}
                    text={(kind) => words.triggerKindText(kind, t)}
                    disabled={disabled}
                    onChange={(kind) => onChange({ ...auto.blankTrigger(kind), id: trigger.id })}
                />
            }
            disabled={disabled}
            onRemove={onRemove}
            onUp={onUp}
            onDown={onDown}
            removeLabel={t("automations.editor.remove")}
            upLabel={t("automations.editor.up")}
            downLabel={t("automations.editor.down")}
        >
            {trigger.kind === "time" && (
                <>
                    <fields.ClockField
                        label={t("automations.fields.at")}
                        path={path}
                        field="at"
                        value={trigger.at}
                        disabled={disabled}
                        onChange={(at) => onChange({ ...trigger, at })}
                    />
                    <fields.DaysPicker
                        path={path}
                        days={trigger.days}
                        disabled={disabled}
                        onChange={(days) => onChange({ ...trigger, days })}
                    />
                </>
            )}
            {trigger.kind === "interval" && (
                <fields.NumberField
                    label={t("automations.fields.every")}
                    path={path}
                    field="minutes"
                    value={trigger.minutes}
                    min={1}
                    step={1}
                    suffix={t("automations.fields.minutesSuffix")}
                    disabled={disabled}
                    onChange={(minutes) => onChange({ ...trigger, minutes })}
                />
            )}
            {trigger.kind === "manual" && (
                <p className="text-xs text-muted-foreground sm:col-span-2">
                    {t("automations.fields.manualHint")}
                </p>
            )}
            {(trigger.kind === "change" || trigger.kind === "stays") && (
                <>
                    <fields.DevicePicker
                        label={t("automations.fields.device")}
                        devices={devices}
                        value={trigger.deviceId}
                        path={path}
                        disabled={disabled}
                        empty={t("automations.fields.noDevices")}
                        onChange={pickDevice}
                    />
                    {device && (
                        <fields.AttributePicker
                            kind={device.kind}
                            value={trigger.attribute}
                            path={path}
                            disabled={disabled}
                            onChange={(attribute) =>
                                onChange(
                                    trigger.kind === "change"
                                        ? { ...trigger, attribute, from: "", to: "" }
                                        : { ...trigger, attribute, is: "" }
                                )
                            }
                        />
                    )}
                </>
            )}
            {trigger.kind === "change" && (
                <>
                    <fields.ValuePicker
                        device={device}
                        attribute={trigger.attribute}
                        value={trigger.from}
                        field="from"
                        path={path}
                        label={t("automations.fields.from")}
                        allowAny
                        disabled={disabled}
                        onChange={(from) => onChange({ ...trigger, from })}
                    />
                    <fields.ValuePicker
                        device={device}
                        attribute={trigger.attribute}
                        value={trigger.to}
                        field="to"
                        path={path}
                        label={t("automations.fields.to")}
                        allowAny
                        disabled={disabled}
                        onChange={(to) => onChange({ ...trigger, to })}
                    />
                </>
            )}
            {trigger.kind === "stays" && (
                <>
                    <fields.ValuePicker
                        device={device}
                        attribute={trigger.attribute}
                        value={trigger.is}
                        field="is"
                        path={path}
                        label={t("automations.fields.is")}
                        disabled={disabled}
                        onChange={(is) => onChange({ ...trigger, is })}
                    />
                    <fields.NumberField
                        label={t("automations.fields.for")}
                        path={path}
                        field="minutes"
                        value={trigger.minutes}
                        min={1}
                        step={1}
                        suffix={t("automations.fields.minutesSuffix")}
                        disabled={disabled}
                        onChange={(minutes) => onChange({ ...trigger, minutes })}
                    />
                </>
            )}
            {trigger.kind === "threshold" && (
                <>
                    <fields.DevicePicker
                        label={t("automations.fields.sensor")}
                        devices={sensors}
                        value={trigger.deviceId}
                        path={path}
                        disabled={disabled}
                        empty={t("automations.fields.noSensors")}
                        onChange={(next) => onChange({ ...trigger, deviceId: next.id })}
                    />
                    <fields.Field
                        label={t("automations.fields.direction")}
                        path={[...path, "direction"]}
                    >
                        {(id) => (
                            <Select
                                id={id}
                                value={trigger.direction}
                                disabled={disabled}
                                options={[
                                    { value: "above", label: t("automations.fields.above") },
                                    { value: "below", label: t("automations.fields.below") }
                                ]}
                                onValueChange={(direction) =>
                                    onChange({
                                        ...trigger,
                                        direction: direction as "above" | "below"
                                    })
                                }
                            />
                        )}
                    </fields.Field>
                    <fields.NumberField
                        label={t("automations.fields.value")}
                        path={path}
                        field="value"
                        value={trigger.value}
                        step="any"
                        suffix={device?.reading?.unit || undefined}
                        disabled={disabled}
                        onChange={(value) => onChange({ ...trigger, value })}
                    />
                </>
            )}
        </fields.NodeCard>
    );
}

function ConditionGroupCard({
    group,
    path,
    devices,
    sensors,
    byId,
    disabled,
    attempted,
    onChange,
    onRemove
}: {
    group: auto.ConditionGroup;
    path: (string | number)[];
    devices: DeviceView[];
    sensors: DeviceView[];
    byId: ReadonlyMap<string, DeviceView>;
    disabled: boolean;
    attempted: boolean;
    onChange: (group: auto.ConditionGroup) => void;
    onRemove: () => void;
}) {
    const t = usePlacesT();
    const setItem = (index: number, item: auto.Condition) =>
        onChange({
            ...group,
            items: group.items.map((entry, at) => (at === index ? item : entry))
        });
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-2">
            <div className="flex items-center gap-2">
                {group.items.length > 1 ? (
                    <MatchPicker
                        value={group.match}
                        disabled={disabled}
                        label={t("automations.editor.groupMatch")}
                        allLabel={t("automations.editor.allOf")}
                        anyLabel={t("automations.editor.anyOf")}
                        onChange={(match) => onChange({ ...group, match })}
                    />
                ) : (
                    <span className="text-xs text-muted-foreground">
                        {t("automations.editor.group")}
                    </span>
                )}
                <span className="flex-1" />
                {!disabled && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={onRemove}
                    >
                        {t("automations.editor.removeGroup")}
                    </Button>
                )}
            </div>
            {group.items.map((condition, index) => (
                <ConditionCard
                    key={condition.id}
                    condition={condition}
                    path={[...path, "items", index]}
                    devices={devices}
                    sensors={sensors}
                    byId={byId}
                    disabled={disabled}
                    onChange={(next) => setItem(index, next)}
                    onRemove={() =>
                        onChange({ ...group, items: group.items.filter((_, at) => at !== index) })
                    }
                    onUp={
                        index > 0
                            ? () => onChange({ ...group, items: move(group.items, index, -1) })
                            : undefined
                    }
                    onDown={
                        index < group.items.length - 1
                            ? () => onChange({ ...group, items: move(group.items, index, 1) })
                            : undefined
                    }
                />
            ))}
            {group.items.length === 0 && attempted && (
                <p className="text-xs text-danger">{t("automations.errors.emptyGroup")}</p>
            )}
            {!disabled && group.items.length < auto.LIMITS.conditionsPerGroup && (
                <AddMenu
                    label={t("automations.editor.addToGroup")}
                    options={auto.CONDITION_KINDS.map((kind) => ({
                        value: kind,
                        label: words.conditionKindText(kind, t)
                    }))}
                    onPick={(kind) =>
                        onChange({
                            ...group,
                            items: [...group.items, auto.blankCondition(kind as auto.ConditionKind)]
                        })
                    }
                />
            )}
        </div>
    );
}

function ConditionCard({
    condition,
    path,
    devices,
    sensors,
    byId,
    disabled,
    onChange,
    onRemove,
    onUp,
    onDown
}: {
    condition: auto.Condition;
    path: (string | number)[];
    devices: DeviceView[];
    sensors: DeviceView[];
    byId: ReadonlyMap<string, DeviceView>;
    disabled: boolean;
    onChange: (condition: auto.Condition) => void;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
}) {
    const t = usePlacesT();
    const device = "deviceId" in condition ? byId.get(condition.deviceId) : undefined;
    return (
        <fields.NodeCard
            kind={
                <KindPicker
                    value={condition.kind}
                    kinds={auto.CONDITION_KINDS}
                    label={t("automations.editor.conditionKind")}
                    text={(kind) => words.conditionKindText(kind, t)}
                    disabled={disabled}
                    onChange={(kind) =>
                        onChange({ ...auto.blankCondition(kind), id: condition.id })
                    }
                />
            }
            disabled={disabled}
            onRemove={onRemove}
            onUp={onUp}
            onDown={onDown}
            removeLabel={t("automations.editor.remove")}
            upLabel={t("automations.editor.up")}
            downLabel={t("automations.editor.down")}
        >
            {condition.kind === "device" && (
                <>
                    <fields.DevicePicker
                        label={t("automations.fields.device")}
                        devices={devices}
                        value={condition.deviceId}
                        path={path}
                        disabled={disabled}
                        empty={t("automations.fields.noDevices")}
                        onChange={(next) =>
                            onChange({
                                ...condition,
                                deviceId: next.id,
                                attribute: auto.attributesFor(next.kind)[0] ?? "state",
                                is: ""
                            })
                        }
                    />
                    {device && (
                        <fields.AttributePicker
                            kind={device.kind}
                            value={condition.attribute}
                            path={path}
                            disabled={disabled}
                            onChange={(attribute) => onChange({ ...condition, attribute, is: "" })}
                        />
                    )}
                    <fields.Field label={t("automations.fields.test")} path={[...path, "negate"]}>
                        {(id) => (
                            <Select
                                id={id}
                                value={condition.negate ? "not" : "is"}
                                disabled={disabled}
                                options={[
                                    { value: "is", label: t("automations.fields.isOption") },
                                    { value: "not", label: t("automations.fields.isNotOption") }
                                ]}
                                onValueChange={(next) =>
                                    onChange({ ...condition, negate: next === "not" })
                                }
                            />
                        )}
                    </fields.Field>
                    <fields.ValuePicker
                        device={device}
                        attribute={condition.attribute}
                        value={condition.is}
                        field="is"
                        path={path}
                        label={t("automations.fields.value")}
                        disabled={disabled}
                        onChange={(is) => onChange({ ...condition, is })}
                    />
                </>
            )}
            {condition.kind === "reading" && (
                <>
                    <fields.DevicePicker
                        label={t("automations.fields.sensor")}
                        devices={sensors}
                        value={condition.deviceId}
                        path={path}
                        disabled={disabled}
                        empty={t("automations.fields.noSensors")}
                        onChange={(next) => onChange({ ...condition, deviceId: next.id })}
                    />
                    <fields.Field label={t("automations.fields.compare")} path={[...path, "op"]}>
                        {(id) => (
                            <Select
                                id={id}
                                value={condition.op}
                                disabled={disabled}
                                options={auto.COMPARISONS.map((op) => ({
                                    value: op,
                                    label: words.comparisonText(op, t)
                                }))}
                                onValueChange={(op) =>
                                    onChange({ ...condition, op: op as auto.Comparison })
                                }
                            />
                        )}
                    </fields.Field>
                    <fields.NumberField
                        label={t("automations.fields.value")}
                        path={path}
                        field="value"
                        value={condition.value}
                        step="any"
                        suffix={device?.reading?.unit || undefined}
                        disabled={disabled}
                        onChange={(value) => onChange({ ...condition, value })}
                    />
                </>
            )}
            {condition.kind === "time" && (
                <>
                    <fields.ClockField
                        label={t("automations.fields.from")}
                        path={path}
                        field="from"
                        value={condition.from}
                        disabled={disabled}
                        onChange={(from) => onChange({ ...condition, from })}
                    />
                    <fields.ClockField
                        label={t("automations.fields.to")}
                        path={path}
                        field="to"
                        value={condition.to}
                        disabled={disabled}
                        onChange={(to) => onChange({ ...condition, to })}
                    />
                </>
            )}
            {condition.kind === "weekday" && (
                <fields.DaysPicker
                    path={path}
                    days={condition.days}
                    disabled={disabled}
                    onChange={(days) => onChange({ ...condition, days })}
                />
            )}
        </fields.NodeCard>
    );
}

function StepCard({
    number,
    step,
    path,
    watched,
    operable: operableDevices,
    canControl,
    byId,
    siblings,
    disabled,
    onChange,
    onRemove,
    onUp,
    onDown
}: {
    number: number;
    step: auto.Step;
    path: (string | number)[];
    watched: DeviceView[];
    operable: DeviceView[];
    canControl: boolean;
    byId: ReadonlyMap<string, DeviceView>;
    siblings: readonly { id: string; name: string }[];
    disabled: boolean;
    onChange: (step: auto.Step) => void;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
}) {
    const t = usePlacesT();
    const device = "deviceId" in step ? byId.get(step.deviceId) : undefined;
    return (
        <fields.NodeCard
            number={number}
            kind={
                <KindPicker
                    value={step.kind}
                    kinds={auto.STEP_KINDS}
                    label={t("automations.editor.stepKind")}
                    text={(kind) => words.stepKindText(kind, t)}
                    disabled={disabled}
                    onChange={(kind) => onChange({ ...auto.blankStep(kind), id: step.id })}
                />
            }
            disabled={disabled}
            onRemove={onRemove}
            onUp={onUp}
            onDown={onDown}
            removeLabel={t("automations.editor.remove")}
            upLabel={t("automations.editor.up")}
            downLabel={t("automations.editor.down")}
        >
            {step.kind === "device" && (
                <>
                    <fields.DevicePicker
                        label={t("automations.fields.device")}
                        devices={operableDevices}
                        value={step.deviceId}
                        path={path}
                        disabled={disabled}
                        empty={
                            canControl
                                ? t("automations.fields.noOperable")
                                : t("automations.fields.noControl")
                        }
                        onChange={(next) => {
                            const offered = auto.stepActionsFor(next.kind);
                            onChange({
                                ...step,
                                deviceId: next.id,
                                do: offered.includes(step.do) ? step.do : (offered[0] ?? step.do)
                            });
                        }}
                    />
                    <fields.Field label={t("automations.fields.do")} path={[...path, "do"]}>
                        {(id, invalid) => (
                            <Select
                                id={id}
                                value={step.do}
                                disabled={disabled || !device}
                                className={invalid ? "border-danger-edge" : undefined}
                                options={(device
                                    ? auto.stepActionsFor(device.kind)
                                    : [step.do]
                                ).map((action) => ({
                                    value: action,
                                    label: words.stepActionText(action, t)
                                }))}
                                onValueChange={(next) =>
                                    onChange({ ...step, do: next as auto.StepDeviceAction })
                                }
                            />
                        )}
                    </fields.Field>
                </>
            )}
            {step.kind === "delay" && (
                <fields.DurationField
                    label={t("automations.fields.wait")}
                    path={path}
                    field="seconds"
                    seconds={step.seconds}
                    disabled={disabled}
                    onChange={(seconds) => onChange({ ...step, seconds })}
                />
            )}
            {step.kind === "wait" && (
                <>
                    <fields.DevicePicker
                        label={t("automations.fields.device")}
                        devices={watched}
                        value={step.deviceId}
                        path={path}
                        disabled={disabled}
                        empty={t("automations.fields.noDevices")}
                        onChange={(next) =>
                            onChange({
                                ...step,
                                deviceId: next.id,
                                attribute: auto.attributesFor(next.kind)[0] ?? "state",
                                is: ""
                            })
                        }
                    />
                    {device && (
                        <fields.AttributePicker
                            kind={device.kind}
                            value={step.attribute}
                            path={path}
                            disabled={disabled}
                            onChange={(attribute) => onChange({ ...step, attribute, is: "" })}
                        />
                    )}
                    <fields.ValuePicker
                        device={device}
                        attribute={step.attribute}
                        value={step.is}
                        field="is"
                        path={path}
                        label={t("automations.fields.until")}
                        disabled={disabled}
                        onChange={(is) => onChange({ ...step, is })}
                    />
                    <fields.NumberField
                        label={t("automations.fields.giveUp")}
                        path={path}
                        field="timeoutMinutes"
                        value={step.timeoutMinutes}
                        min={1}
                        step={1}
                        suffix={t("automations.fields.minutesSuffix")}
                        disabled={disabled}
                        onChange={(timeoutMinutes) => onChange({ ...step, timeoutMinutes })}
                    />
                    <fields.Field
                        label={t("automations.fields.onTimeout")}
                        path={[...path, "onTimeout"]}
                        className="sm:col-span-2"
                    >
                        {(id) => (
                            <Select
                                id={id}
                                value={step.onTimeout}
                                disabled={disabled}
                                options={[
                                    { value: "stop", label: t("automations.fields.timeoutStop") },
                                    {
                                        value: "continue",
                                        label: t("automations.fields.timeoutContinue")
                                    }
                                ]}
                                onValueChange={(next) =>
                                    onChange({ ...step, onTimeout: next as "stop" | "continue" })
                                }
                            />
                        )}
                    </fields.Field>
                </>
            )}
            {step.kind === "notify" && (
                <fields.Field
                    label={t("automations.fields.message")}
                    path={[...path, "message"]}
                    required
                    className="sm:col-span-2"
                >
                    {(id, invalid) => (
                        <Textarea
                            id={id}
                            rows={2}
                            value={step.message}
                            maxLength={auto.LIMITS.message}
                            disabled={disabled}
                            placeholder={t("automations.fields.messagePlaceholder")}
                            aria-invalid={invalid || undefined}
                            onChange={(event) => onChange({ ...step, message: event.target.value })}
                        />
                    )}
                </fields.Field>
            )}
            {step.kind === "run" && (
                <fields.Field
                    label={t("automations.fields.automation")}
                    path={[...path, "automationId"]}
                    required
                    className="sm:col-span-2"
                >
                    {(id, invalid) =>
                        siblings.length === 0 ? (
                            <p id={id} className="text-xs text-muted-foreground">
                                {t("automations.fields.noOthers")}
                            </p>
                        ) : (
                            <Select
                                id={id}
                                value={step.automationId}
                                disabled={disabled}
                                placeholder={t("automations.fields.chooseAutomation")}
                                className={invalid ? "border-danger-edge" : undefined}
                                options={siblings.map((sibling) => ({
                                    value: sibling.id,
                                    label: sibling.name
                                }))}
                                onValueChange={(automationId) =>
                                    onChange({ ...step, automationId })
                                }
                            />
                        )
                    }
                </fields.Field>
            )}
        </fields.NodeCard>
    );
}

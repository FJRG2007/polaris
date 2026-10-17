"use client";

/**
 * One automation, laid out as it runs: WHEN any of these happens, IF these hold,
 * THEN these steps, in order - as a column of cards joined by a line, or as a
 * diagram of the same nodes (see `automation-canvas.tsx`), each card or node
 * added, removed and moved where it sits. The reader's choice between the two
 * is kept in this browser only; the stored automation is the same either way.
 *
 * Checked as it is typed, against the same schema and the same device checks
 * the server runs, so a problem is said under the field it is about. A field not
 * filled in yet is unfinished rather than wrong: it carries a `*`, Save waits,
 * and only pressing Save anyway says which ones are missing.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Filter, Loader2, Play, Redo2, Undo2, Zap } from "lucide-react";
import {
    Button,
    Input,
    SegmentedControl,
    Select,
    Skeleton,
    Switch,
    Textarea,
    cn,
    useToast
} from "@polaris/ui";
import * as blocks from "@polaris/ui/automation-blocks";
import * as clipboard from "@polaris/ui/automation-clipboard";
import { useDraftHistory } from "@polaris/ui/automation-history";
import { BLOCK_LIMITS, blockTitle, insertAfter, moveBy, withFreshIds } from "@polaris/core";
import * as flow from "@polaris/ui/automation";
import { RunLog } from "./run-log";
import * as actions from "./actions";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import * as auto from "../../lib/automation-kinds";
import * as purposes from "../../lib/automation-purposes";
import * as words from "../../lib/automation-words";
import type { DeviceView } from "../../lib/device-kinds";
import { dropAutomationsCache } from "./cache";
import * as fields from "./flow-fields";
import * as sun from "./sun-fields";
import { savePlaceLocationAction } from "../actions";
import { AutomationCanvas } from "./automation-canvas";
import { AddBlockButton, RoomsProvider, blockIcon } from "./add-block";
import type { RoomView } from "../../lib/room-kinds";
import { swap, within } from "@polaris/ui/automation-graph";
import type { CanvasSelection, NodeState } from "@polaris/ui/automation-canvas";

const { runAction } = hostUi.runAction;
const { useDisplayFormat } = hostUi.displayFormat;

/** An automation while it is being edited: the input the server takes. */
export type Draft = auto.AutomationInput;

type Tab = "flow" | "runs";

/** The three lists a block can be in. */
export type BlockRole = "trigger" | "group" | "step";
type Block = auto.Trigger | auto.ConditionGroup | auto.Step;

/** Which editor the clipboard is holding a block for. */
const SURFACE = "places";

/** Where the panel's width is kept, in this browser only. */
const PANEL_KEY = "polaris.places.automationPanel";

const ROLES: readonly BlockRole[] = ["trigger", "group", "step"];

export function blocksOf(definition: auto.AutomationDefinition, role: BlockRole): readonly Block[] {
    return role === "trigger"
        ? definition.triggers
        : role === "group"
          ? definition.conditions.groups
          : definition.actions;
}

export function withBlocks(
    definition: auto.AutomationDefinition,
    role: BlockRole,
    items: readonly Block[]
): auto.AutomationDefinition {
    if (role === "trigger") return { ...definition, triggers: items as auto.Trigger[] };
    if (role === "group")
        return {
            ...definition,
            conditions: { ...definition.conditions, groups: items as auto.ConditionGroup[] }
        };
    return { ...definition, actions: items as auto.Step[] };
}

const ROOM: Record<BlockRole, number> = {
    trigger: auto.LIMITS.triggers,
    group: auto.LIMITS.groups,
    step: auto.LIMITS.steps
};

/** Whether something taken off the clipboard is a block of this list at all;
 *  its fields are then checked like any other edit, under the fields. */
export function pastable(role: BlockRole, value: unknown): value is Block {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const block = value as { id?: unknown; kind?: unknown; items?: unknown };
    if (typeof block.id !== "string") return false;
    if (role === "group") return Array.isArray(block.items);
    const kinds: readonly string[] = role === "trigger" ? auto.TRIGGER_KINDS : auto.STEP_KINDS;
    return typeof block.kind === "string" && kinds.includes(block.kind);
}

/** A block with its name or note set, or taken away when empty - absent rather
 *  than blank, so a block nobody named saves exactly as it did before. */
export function withOwnText<B extends Block>(
    block: B,
    field: "alias" | "note",
    value: string | undefined
): B {
    const next = { ...block } as B & { alias?: string; note?: string };
    if (value) next[field] = value;
    else delete next[field];
    return next;
}

/** A block made from the add dialog, pointed at the device chosen on "By target". */
export function triggerFor(kind: string, target?: DeviceView): auto.Trigger {
    const purpose = kind.startsWith(purposes.PURPOSE_PREFIX)
        ? kind.slice(purposes.PURPOSE_PREFIX.length)
        : null;
    if (purpose !== null) {
        const made =
            target && purposes.isTriggerPurpose(purpose)
                ? purposes.purposeTrigger(purpose, target)
                : null;
        return made ?? auto.blankTrigger("change");
    }
    const blank = auto.blankTrigger(kind as auto.TriggerKind);
    return target ? auto.triggerOn(blank, target) : blank;
}

export function conditionFor(kind: string, target?: DeviceView): auto.Condition {
    const purpose = kind.startsWith(purposes.PURPOSE_PREFIX)
        ? kind.slice(purposes.PURPOSE_PREFIX.length)
        : null;
    if (purpose !== null) {
        const made =
            target && purposes.isConditionPurpose(purpose)
                ? purposes.purposeCondition(purpose, target)
                : null;
        return made ?? auto.blankCondition("device");
    }
    const blank = auto.blankCondition(kind as auto.ConditionKind);
    return target ? auto.conditionOn(blank, target) : blank;
}

export function stepFor(kind: string, target?: DeviceView): auto.Step {
    const blank = auto.blankStep(kind as auto.StepKind);
    return target ? auto.stepOn(blank, target) : blank;
}

function pathOf(role: BlockRole, index: number): (string | number)[] {
    return role === "trigger"
        ? ["definition", "triggers", index]
        : role === "group"
          ? ["definition", "conditions", "groups", index]
          : ["definition", "actions", index];
}

/** Where the reader's choice of layout is kept, in this browser only. */
const LAYOUT_KEY = "polaris.places.automationLayout";

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
    "automations.errors.days",
    "automations.errors.noTriggerPicked"
]);

function pathKey(path: readonly (string | number)[]): string {
    return path.join(".");
}

/** The rooms of a place that has none, one array for every render. */
const NO_ROOMS: readonly RoomView[] = [];

/** A block with its set changed: its devices, and how they count - which goes
 *  with the set when it is down to one device again. */
function setOf<T extends auto.Trigger | auto.Condition | auto.Step>(
    block: T,
    ids: readonly string[],
    count: auto.Behaviour | auto.Quantifier | undefined
): T {
    if (!("deviceId" in block)) return block;
    const next = { ...auto.withTargets(block, ids) } as Record<string, unknown>;
    // A device step tells every device, so it has nothing to count by.
    if ("do" in block) return next as T;
    const field =
        block.kind === "device" || block.kind === "reading" || block.kind === "wait"
            ? "quantifier"
            : "behaviour";
    delete next[field];
    if (ids.length > 1 && count) next[field] = count;
    return next as T;
}

/** A block's own name, note and switch, kept when the Watch picker turns it into
 *  the other kind - picking the temperature is not starting the block over. */
function baseOf(block: { alias?: string; note?: string; enabled?: boolean }) {
    return {
        ...(block.alias !== undefined ? { alias: block.alias } : {}),
        ...(block.note !== undefined ? { note: block.note } : {}),
        ...(block.enabled !== undefined ? { enabled: block.enabled } : {})
    };
}

/** The engine's comparison: a sensor's words come in whatever case it sends. */
function sameWord(a: string, b: string): boolean {
    return a !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();
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
    const history = useDraftHistory<Draft>();
    const draft = history.value;
    const latestDraft = useRef(draft);
    latestDraft.current = draft;
    const toast = useToast();
    const [selected, setSelected] = useState<{ role: BlockRole; id: string } | null>(null);
    const [dialog, setDialog] = useState<{
        kind: "rename" | "note";
        role: BlockRole;
        id: string;
    } | null>(null);
    // Read again when something is copied, so Paste is offered at once.
    const [, setClipped] = useState(0);
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
    const [layout, chooseLayout] = flow.useFlowLayout(LAYOUT_KEY);
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
            history.reset(next);
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
    const lookup = useMemo<words.DeviceLookup>(
        () => words.lookupOf(devices, loaded?.context.rooms ?? NO_ROOMS),
        [devices, loaded]
    );
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
            selfId: automationId,
            rooms: loaded?.context.rooms ?? NO_ROOMS,
            floors: loaded?.context.floors
        });
    }, [normalized, devices, loaded, automationId]);

    const issueLookup = useMemo<flow.IssueLookup>(() => {
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

    /** How a node stands, for the canvas to mark it: wrong as soon as it is,
     *  merely unfinished until Save is pressed - the same split the fields make. */
    const stateOf = useCallback(
        (path: readonly (string | number)[]): NodeState => {
            let state: NodeState = "ok";
            for (const issue of [...issues, ...serverIssues]) {
                if (!within(issue.path, path)) continue;
                if (attempted || !UNFINISHED.has(issue.message)) return "invalid";
                state = "incomplete";
            }
            return state;
        },
        [issues, serverIssues, attempted]
    );

    const edit = (change: (current: Draft) => Draft, options?: { group?: boolean }) => {
        setServerIssues([]);
        setNotice("");
        history.change(change, options);
    };
    const editDefinition = (
        change: (current: auto.AutomationDefinition) => auto.AutomationDefinition,
        options?: { group?: boolean }
    ) => edit((current) => ({ ...current, definition: change(current.definition) }), options);

    const save = async (): Promise<boolean> => {
        if (!draft || !normalized || readOnly) return false;
        setAttempted(true);
        if (!dirty) return issues.length === 0;
        if (issues.length > 0 || inFlight.current.save) return false;
        inFlight.current.save = true;
        setSaving(true);
        setError("");
        const result = await runAction(
            () => actions.saveAutomationAction(automationId, normalized),
            setError
        );
        inFlight.current.save = false;
        setSaving(false);
        if (!result) return false;
        if (result.issues) setServerIssues(result.issues);
        if (result.error || !result.automation) {
            setError(result.error ?? t("refusals.failed"));
            return false;
        }
        dropAutomationsCache();
        const stored: Draft = {
            name: result.automation.name,
            enabled: result.automation.enabled,
            placeId: result.automation.placeId,
            definition: result.automation.definition
        };
        history.replace(stored);
        setSaved(JSON.stringify(auto.normalizeAutomationInput(stored)));
        setLoaded((current) =>
            current ? { ...current, automation: result.automation ?? null } : current
        );
        setAttempted(false);
        setNotice(t("automations.editor.saved"));
        // Moved on save: from here on it is edited where it now runs.
        if (result.automation.movedTo) router.replace(auto.automationHref(result.automation));
        else if (!automationId) router.replace(auto.automationHref(result.automation));
        return true;
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
    const blockStrings: blocks.BlockStrings = {
        menu: t("automations.blocks.menu"),
        rename: t("automations.blocks.rename"),
        addNote: t("automations.blocks.addNote"),
        editNote: t("automations.blocks.editNote"),
        duplicate: t("automations.blocks.duplicate"),
        copy: t("automations.blocks.copy"),
        cut: t("automations.blocks.cut"),
        paste: t("automations.blocks.paste"),
        moveUp: t("automations.blocks.moveUp"),
        moveDown: t("automations.blocks.moveDown"),
        disable: t("automations.blocks.disable"),
        enable: t("automations.blocks.enable"),
        remove: t("automations.blocks.remove"),
        disabled: t("automations.blocks.disabled"),
        note: t("automations.blocks.note"),
        closePanel: t("automations.blocks.closePanel"),
        resizePanel: t("automations.blocks.resizePanel"),
        save: t("automations.blocks.save"),
        cancel: t("automations.blocks.cancel"),
        removeNote: t("automations.blocks.removeNote")
    };
    const leaveStrings: blocks.LeaveStrings = {
        title: t("automations.leave.title"),
        body: t("automations.leave.body"),
        newTitle: t("automations.leave.newTitle"),
        newBody: t("automations.leave.newBody"),
        save: t("automations.leave.save"),
        discard: t("automations.leave.discard"),
        discardNew: t("automations.leave.discardNew"),
        stay: t("automations.leave.stay")
    };

    /** Change one list of the definition, as a step of its own in the history. */
    const editBlocks = (role: BlockRole, change: (items: readonly Block[]) => readonly Block[]) =>
        editDefinition((current) => withBlocks(current, role, change(blocksOf(current, role))), {
            group: false
        });
    const blockAt = (role: BlockRole, index: number): Block | undefined =>
        draft ? blocksOf(draft.definition, role)[index] : undefined;
    const roomFor = (role: BlockRole) =>
        draft !== null && blocksOf(draft.definition, role).length < ROOM[role];

    /** A new block goes at the end of its list and opens, ready to fill in. */
    const addBlock = (role: BlockRole, block: Block) => {
        editBlocks(role, (items) => [...items, block]);
        setSelected({ role, id: block.id });
    };
    const duplicateBlock = (role: BlockRole, index: number) => {
        const block = blockAt(role, index);
        if (!block || !roomFor(role)) return;
        const copy = withFreshIds(block, auto.nodeIdOf);
        editBlocks(role, (items) => insertAfter(items, index, copy));
        setSelected({ role, id: copy.id });
    };
    const removeBlock = (role: BlockRole, index: number, announce = true) => {
        const block = blockAt(role, index);
        if (!block) return;
        editBlocks(role, (items) => items.filter((entry) => entry.id !== block.id));
        setSelected((current) => (current?.id === block.id ? null : current));
        if (!announce) return;
        toast.show({
            key: "places-automation-removed",
            title: t(`automations.blocks.removed.${role}`),
            actions: [
                {
                    label: t("automations.blocks.undo"),
                    run: async () => {
                        const now = latestDraft.current;
                        const listed = now ? blocksOf(now.definition, role) : [];
                        if (listed.some((entry) => entry.id === block.id)) return null;
                        if (listed.length >= ROOM[role]) {
                            toast.show({
                                key: "places-automation-removed",
                                title: t("automations.blocks.noRoom")
                            });
                            return null;
                        }
                        // Put back where it was, unless it is back already.
                        editBlocks(role, (items) =>
                            items.some((entry) => entry.id === block.id)
                                ? items
                                : insertAfter(items, index - 1, block)
                        );
                        return null;
                    }
                }
            ]
        });
    };
    const copyBlock = (role: BlockRole, index: number, cut = false) => {
        const block = blockAt(role, index);
        if (!block) return;
        clipboard.copyBlock({ surface: SURFACE, role, block });
        setClipped((count) => count + 1);
        toast.show({
            key: "places-automation-clipboard",
            title: t(
                cut ? `automations.blocks.cutDone.${role}` : `automations.blocks.copied.${role}`
            )
        });
        if (cut) removeBlock(role, index, false);
    };
    const pasteBlock = (role: BlockRole, after: number) => {
        const taken = clipboard.pastedBlock(SURFACE, role);
        if (!pastable(role, taken)) return;
        if (!roomFor(role)) {
            toast.show({
                key: "places-automation-clipboard",
                title: t("automations.blocks.noRoom")
            });
            return;
        }
        const block = withFreshIds(taken, auto.nodeIdOf);
        editBlocks(role, (items) => insertAfter(items, after, block));
        setSelected({ role, id: block.id });
        toast.show({
            key: "places-automation-clipboard",
            title: t(`automations.blocks.pasted.${role}`)
        });
    };
    const selectedIndex =
        selected && draft
            ? blocksOf(draft.definition, selected.role).findIndex(
                  (block) => block.id === selected.id
              )
            : -1;
    /** Paste after the selected block when it is the same kind of block, else at
     *  the end of the list the copied one belongs in. */
    const pasteHere = () => {
        if (!draft) return;
        const role =
            selected && clipboard.hasBlock(SURFACE, selected.role)
                ? selected.role
                : ROLES.find((each) => clipboard.hasBlock(SURFACE, each));
        if (!role) return;
        pasteBlock(
            role,
            selected?.role === role && selectedIndex >= 0
                ? selectedIndex
                : blocksOf(draft.definition, role).length - 1
        );
    };

    /** The add dialog's paste entry, when the clipboard holds a block for `role`. */
    const pasteFor = (role: BlockRole) =>
        draft && clipboard.hasBlock(SURFACE, role)
            ? () => pasteBlock(role, blocksOf(draft.definition, role).length - 1)
            : undefined;

    const leave = blocks.useLeaveGuard(dirty && !readOnly, (href) => router.push(href));
    const onSelected = (run: (role: BlockRole, index: number) => void) =>
        selected && selectedIndex >= 0 ? () => run(selected.role, selectedIndex) : undefined;
    blocks.useEditorKeys(
        {
            onSave: () => void save(),
            onUndo: history.undo,
            onRedo: history.redo,
            onCopy: onSelected((role, index) => copyBlock(role, index)),
            onCut: onSelected((role, index) => copyBlock(role, index, true)),
            onPaste: pasteHere,
            onRemove: onSelected((role, index) => removeBlock(role, index))
        },
        !readOnly && tab === "flow" && draft !== null && leave.pending === null && dialog === null
    );

    const header = (
        <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="ghost" className="px-2">
                <Link href="/places/devices/automations">
                    <ArrowLeft className="size-4 shrink-0" />
                    {t("automations.editor.back")}
                </Link>
            </Button>
            <span className="flex-1" />
            {loaded && tab === "flow" && !readOnly && (
                <span className="flex items-center">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="size-8 p-0"
                        aria-label={t("automations.blocks.undo")}
                        title={t("automations.blocks.undo")}
                        disabled={!history.canUndo}
                        onClick={history.undo}
                    >
                        <Undo2 className="size-4" />
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="size-8 p-0"
                        aria-label={t("automations.blocks.redo")}
                        title={t("automations.blocks.redo")}
                        disabled={!history.canRedo}
                        onClick={history.redo}
                    >
                        <Redo2 className="size-4" />
                    </Button>
                </span>
            )}
            {loaded && tab === "flow" && (
                <SegmentedControl<flow.FlowLayout>
                    size="sm"
                    value={layout}
                    onValueChange={chooseLayout}
                    aria-label={t("automations.canvas.layout")}
                    options={[
                        { value: "form", label: t("automations.canvas.form") },
                        { value: "visual", label: t("automations.canvas.visual") }
                    ]}
                />
            )}
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
    // What has a number to compare: a sensor, or an air conditioner's room.
    const sensors = devices.filter((device) => auto.measures(device.kind));
    const operableDevices = canControl ? devices.filter(fields.operable) : [];
    const blocked = issues.length > 0 || !dirty;

    // One card per node, drawn in the form's column and in the canvas's
    // inspector alike, so both edit with the same fields and the same checks.
    // Numbered only while a "Triggered by" condition reads the numbers.
    const numbered = sun.numbersTriggers(definition);
    const triggerIds = definition.triggers.map((trigger) => trigger.id);
    const setLocation = async (location: { latitude: number; longitude: number }) => {
        const result = await runAction(
            () => savePlaceLocationAction(loaded.context.placeId, location),
            setError
        );
        if (!result) return t("location.failed");
        if (result.error) return result.error;
        setLoaded((current) =>
            current
                ? { ...current, context: { ...current.context, location: result.location ?? null } }
                : current
        );
    };
    const triggerCard = (trigger: auto.Trigger, index: number, plain = false) => (
        <TriggerCard
            key={trigger.id}
            number={numbered ? index + 1 : undefined}
            plain={plain}
            trigger={trigger}
            path={["definition", "triggers", index]}
            devices={watchedDevices}
            sensors={sensors}
            byId={byId}
            disabled={readOnly}
            onChange={(next) =>
                editDefinition((current) => ({
                    ...current,
                    triggers: current.triggers.map((entry, at) => (at === index ? next : entry))
                }))
            }
            onRemove={() =>
                editDefinition((current) => ({
                    ...current,
                    triggers: current.triggers.filter((_, at) => at !== index)
                }))
            }
            onUp={
                index > 0
                    ? () =>
                          editDefinition((current) => ({
                              ...current,
                              triggers: swap(current.triggers, index, -1)
                          }))
                    : undefined
            }
            onDown={
                index < definition.triggers.length - 1
                    ? () =>
                          editDefinition((current) => ({
                              ...current,
                              triggers: swap(current.triggers, index, 1)
                          }))
                    : undefined
            }
        />
    );

    const groupCard = (group: auto.ConditionGroup, groupIndex: number, plain = false) => (
        <ConditionGroupCard
            key={group.id}
            plain={plain}
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
                        groups: current.conditions.groups.map((entry, at) =>
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
                        groups: current.conditions.groups.filter((_, at) => at !== groupIndex)
                    }
                }))
            }
        />
    );

    const stepCard = (step: auto.Step, index: number, plain = false) => (
        <StepCard
            key={step.id}
            plain={plain}
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
                    actions: current.actions.map((entry, at) => (at === index ? next : entry))
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
                              actions: swap(current.actions, index, -1)
                          }))
                    : undefined
            }
            onDown={
                index < definition.actions.length - 1
                    ? () =>
                          editDefinition((current) => ({
                              ...current,
                              actions: swap(current.actions, index, 1)
                          }))
                    : undefined
            }
        />
    );

    const sentenceOf = (role: BlockRole, block: Block): string => {
        if (role === "trigger") return words.describeTrigger(block as auto.Trigger, lookup, t);
        if (role === "step")
            return words.describeStep(block as auto.Step, lookup, automationName, t);
        const first = (block as auto.ConditionGroup).items[0];
        return first
            ? words.describeCondition(first, lookup, t, triggerIds)
            : t("automations.editor.group");
    };
    /** A group reads as its first condition, with how the rest join it. */
    const chipsOf = (role: BlockRole, block: Block): string[] => {
        if (role !== "group") return [];
        const group = block as auto.ConditionGroup;
        if (group.items.length < 2) return [];
        return [
            group.match === "all" ? t("automations.editor.allOf") : t("automations.editor.anyOf"),
            `+${group.items.length - 1}`
        ];
    };
    const actionsFor = (role: BlockRole, index: number): blocks.BlockActions => {
        const items = blocksOf(definition, role);
        const block = items[index];
        const room = items.length < ROOM[role];
        if (!block) return {};
        return {
            onRename: () => setDialog({ kind: "rename", role, id: block.id }),
            onNote: () => setDialog({ kind: "note", role, id: block.id }),
            hasNote: Boolean(block.note),
            onDuplicate: room ? () => duplicateBlock(role, index) : undefined,
            onCopy: () => copyBlock(role, index),
            onCut: () => copyBlock(role, index, true),
            onPaste:
                room && clipboard.hasBlock(SURFACE, role)
                    ? () => pasteBlock(role, index)
                    : undefined,
            onUp: index > 0 ? () => editBlocks(role, (list) => moveBy(list, index, -1)) : undefined,
            onDown:
                index < items.length - 1
                    ? () => editBlocks(role, (list) => moveBy(list, index, 1))
                    : undefined,
            onRemove: () => removeBlock(role, index)
        };
    };
    /** One list as rows that read as sentences; pressing one opens it. */
    const rowsOf = (role: BlockRole, label: string) => {
        const items = blocksOf(definition, role);
        if (items.length === 0) return null;
        return (
            <flow.SortableList
                items={items}
                label={label}
                handleLabel={t("automations.canvas.handle")}
                disabled={readOnly}
                onMove={(from, to) => editBlocks(role, (list) => flow.moved(list, from, to))}
            >
                {(block, index, handle) => {
                    const title = blockTitle(block, sentenceOf(role, block));
                    return (
                        <blocks.BlockRow
                            handle={handle}
                            number={role === "step" ? index + 1 : undefined}
                            icon={blockIcon(role, block)}
                            title={title}
                            chips={chipsOf(role, block)}
                            note={block.note}
                            selected={selected?.id === block.id}
                            state={stateOf(pathOf(role, index))}
                            strings={blockStrings}
                            menu={
                                readOnly ? undefined : (
                                    <blocks.BlockMenu
                                        strings={blockStrings}
                                        label={title}
                                        actions={actionsFor(role, index)}
                                    />
                                )
                            }
                            onSelect={() =>
                                setSelected((current) =>
                                    current?.id === block.id ? null : { role, id: block.id }
                                )
                            }
                            onRemove={readOnly ? undefined : () => removeBlock(role, index)}
                        />
                    );
                }}
            </flow.SortableList>
        );
    };

    const selectedBlock =
        selected && selectedIndex >= 0
            ? blocksOf(definition, selected.role)[selectedIndex]
            : undefined;
    const selectedTitle =
        selected && selectedBlock
            ? blockTitle(selectedBlock, sentenceOf(selected.role, selectedBlock))
            : "";
    const panel =
        selected && selectedBlock ? (
            <blocks.BlockPanel
                open
                title={selectedTitle}
                icon={blockIcon(selected.role, selectedBlock)}
                strings={blockStrings}
                sizeKey={PANEL_KEY}
                onClose={() => setSelected(null)}
                menu={
                    readOnly ? undefined : (
                        <blocks.BlockMenu
                            strings={blockStrings}
                            label={selectedTitle}
                            actions={actionsFor(selected.role, selectedIndex)}
                        />
                    )
                }
            >
                {selected.role === "trigger"
                    ? triggerCard(selectedBlock as auto.Trigger, selectedIndex, true)
                    : selected.role === "group"
                      ? groupCard(selectedBlock as auto.ConditionGroup, selectedIndex, true)
                      : stepCard(selectedBlock as auto.Step, selectedIndex, true)}
                {selectedBlock.note && (
                    <p className="mt-3 whitespace-pre-wrap break-words border-t border-border pt-3 text-xs text-muted-foreground">
                        {selectedBlock.note}
                    </p>
                )}
            </blocks.BlockPanel>
        ) : null;

    const dialogBlock = dialog
        ? blocksOf(definition, dialog.role).find((block) => block.id === dialog.id)
        : undefined;
    const blockDialogs = (
        <>
            <blocks.BlockTextDialog
                open={dialog !== null && dialogBlock !== undefined}
                title={
                    dialog
                        ? t(
                              dialog.kind === "rename"
                                  ? `automations.blocks.renameTitle.${dialog.role}`
                                  : `automations.blocks.noteTitle.${dialog.role}`
                          )
                        : ""
                }
                label={
                    dialog?.kind === "note"
                        ? t("automations.blocks.noteLabel")
                        : t("automations.blocks.nameLabel")
                }
                value={(dialog?.kind === "note" ? dialogBlock?.note : dialogBlock?.alias) ?? ""}
                maxLength={dialog?.kind === "note" ? BLOCK_LIMITS.note : BLOCK_LIMITS.alias}
                multiline={dialog?.kind === "note"}
                strings={blockStrings}
                onClose={() => setDialog(null)}
                onSave={(value) => {
                    if (!dialog) return;
                    const { role, id, kind } = dialog;
                    editBlocks(role, (items) =>
                        items.map((block) =>
                            block.id === id
                                ? withOwnText(block, kind === "rename" ? "alias" : "note", value)
                                : block
                        )
                    );
                }}
            />
            <blocks.UnsavedChangesDialog
                open={leave.pending !== null}
                isNew={!automationId}
                strings={leaveStrings}
                saving={saving}
                onStay={leave.stay}
                onDiscard={leave.go}
                onSave={() => void save().then((ok) => (ok ? leave.go() : leave.stay()))}
            />
        </>
    );
    const groupsMatch = definition.conditions.groups.length > 1 && (
        <flow.MatchPicker
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
    );

    /** What the canvas opens for its selected node: the form's own card. */
    const inspect = (selection: CanvasSelection): ReactNode => {
        switch (selection.role) {
            case "trigger": {
                const trigger = definition.triggers[selection.index];
                return trigger ? triggerCard(trigger, selection.index) : null;
            }
            case "group": {
                const group = definition.conditions.groups[selection.index];
                return group ? groupCard(group, selection.index) : null;
            }
            case "step": {
                const step = definition.actions[selection.index];
                return step ? stepCard(step, selection.index) : null;
            }
            case "gate":
                return (
                    <div className="flex flex-col gap-2">
                        <p className="text-xs text-muted-foreground">
                            {definition.conditions.groups.length === 0
                                ? t("automations.editor.ifEmpty")
                                : t("automations.editor.ifHint")}
                        </p>
                        {groupsMatch}
                    </div>
                );
        }
    };

    const stageIssues = attempted
        ? [issueLookup(["definition", "triggers"]), issueLookup(["definition", "actions"])].filter(
              (issue): issue is string => issue !== undefined
          )
        : [];

    const footnote = (
        <>
            {t("automations.editor.zone", { zone: definition.timeZone })}
            {loaded.automation?.ownerName
                ? ` ${t("automations.editor.runsAs", { name: loaded.automation.ownerName })}`
                : ""}
        </>
    );

    return (
        <RoomsProvider value={loaded?.context.rooms ?? NO_ROOMS}>
            <sun.AutomationScopeProvider
                value={{
                    triggers: definition.triggers,
                    lookup,
                    location: loaded.context.location ?? null,
                    timeZone: definition.timeZone,
                    setLocation: readOnly ? undefined : setLocation
                }}
            >
                <flow.IssueProvider value={issueLookup}>
                    <div className="flex flex-col gap-4">
                        {header}

                        <div className="flex flex-wrap items-end gap-3">
                            <flow.Field
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
                                            edit((current) => ({
                                                ...current,
                                                name: event.target.value
                                            }))
                                        }
                                    />
                                )}
                            </flow.Field>
                            <label className="flex h-8 items-center gap-2 text-xs text-muted-foreground">
                                <Switch
                                    checked={draft.enabled}
                                    disabled={readOnly}
                                    aria-label={t("automations.editor.enabled")}
                                    onChange={(enabled) =>
                                        edit((current) => ({ ...current, enabled }))
                                    }
                                />
                                {draft.enabled
                                    ? t("automations.editor.on")
                                    : t("automations.editor.off")}
                            </label>
                            {!readOnly && (
                                <>
                                    {automationId && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={running || dirty || !draft.enabled}
                                            title={
                                                dirty
                                                    ? t("automations.editor.saveFirst")
                                                    : undefined
                                            }
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
                        ) : layout === "visual" ? (
                            <div className="flex flex-col gap-2">
                                <AutomationCanvas
                                    definition={definition}
                                    readOnly={readOnly}
                                    onChange={editDefinition}
                                    stateOf={stateOf}
                                    lookup={lookup}
                                    automationName={automationName}
                                    renderInspector={inspect}
                                    stageIssues={stageIssues}
                                />
                                <p className="text-[0.6875rem] text-foreground-subtle">
                                    {footnote}
                                </p>
                            </div>
                        ) : (
                            <div className="flex min-w-0 items-start gap-4">
                                <ol className="flex min-w-0 flex-1 flex-col">
                                    <flow.Stage
                                        icon={<Zap className="size-4" />}
                                        title={t("automations.editor.when")}
                                        hint={t("automations.editor.whenHint")}
                                        issue={
                                            attempted
                                                ? issueLookup(["definition", "triggers"])
                                                : undefined
                                        }
                                    >
                                        {rowsOf("trigger", t("automations.editor.when"))}
                                        {!readOnly &&
                                            definition.triggers.length < auto.LIMITS.triggers && (
                                                <AddBlockButton
                                                    role="trigger"
                                                    label={t("automations.editor.addTrigger")}
                                                    devices={devices}
                                                    onPaste={pasteFor("trigger")}
                                                    onPick={(kind, target) =>
                                                        addBlock(
                                                            "trigger",
                                                            triggerFor(kind, target)
                                                        )
                                                    }
                                                />
                                            )}
                                    </flow.Stage>

                                    <flow.Stage
                                        icon={<Filter className="size-4" />}
                                        title={t("automations.editor.if")}
                                        hint={
                                            definition.conditions.groups.length === 0
                                                ? t("automations.editor.ifEmpty")
                                                : t("automations.editor.ifHint")
                                        }
                                    >
                                        {groupsMatch}
                                        {rowsOf("group", t("automations.editor.if"))}
                                        {!readOnly &&
                                            definition.conditions.groups.length <
                                                auto.LIMITS.groups && (
                                                <AddBlockButton
                                                    role="condition"
                                                    label={t("automations.editor.addCondition")}
                                                    devices={devices}
                                                    onPaste={pasteFor("group")}
                                                    onPick={(kind, target) =>
                                                        addBlock("group", {
                                                            id: auto.nodeIdOf(),
                                                            match: "all",
                                                            items: [conditionFor(kind, target)]
                                                        })
                                                    }
                                                />
                                            )}
                                    </flow.Stage>

                                    <flow.Stage
                                        icon={<Play className="size-4" />}
                                        title={t("automations.editor.then")}
                                        hint={t("automations.editor.thenHint")}
                                        issue={
                                            attempted
                                                ? issueLookup(["definition", "actions"])
                                                : undefined
                                        }
                                        last
                                    >
                                        {rowsOf("step", t("automations.editor.then"))}
                                        {!readOnly &&
                                            definition.actions.length < auto.LIMITS.steps && (
                                                <AddBlockButton
                                                    role="step"
                                                    label={t("automations.editor.addStep")}
                                                    devices={devices}
                                                    canControl={canControl}
                                                    onPaste={pasteFor("step")}
                                                    onPick={(kind, target) =>
                                                        addBlock("step", stepFor(kind, target))
                                                    }
                                                />
                                            )}
                                    </flow.Stage>
                                    <li className="pt-2 text-[0.6875rem] text-foreground-subtle">
                                        {footnote}
                                    </li>
                                </ol>
                                {panel}
                            </div>
                        )}
                        {blockDialogs}
                    </div>
                </flow.IssueProvider>
            </sun.AutomationScopeProvider>
        </RoomsProvider>
    );
}

function TriggerCard({
    trigger,
    number,
    path,
    devices,
    sensors,
    byId,
    disabled,
    plain,
    onChange,
    onRemove,
    onUp,
    onDown
}: {
    trigger: auto.Trigger;
    /** Its position, shown while a "Triggered by" condition names triggers. */
    number?: number;
    path: (string | number)[];
    devices: DeviceView[];
    sensors: DeviceView[];
    byId: ReadonlyMap<string, DeviceView>;
    disabled: boolean;
    plain?: boolean;
    onChange: (trigger: auto.Trigger) => void;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
}) {
    const t = usePlacesT();
    const device = "deviceId" in trigger ? byId.get(trigger.deviceId) : undefined;
    const pickDevice = (next: DeviceView) => {
        if (!("deviceId" in trigger)) return;
        onChange(auto.triggerOn(trigger, next));
    };
    return (
        <flow.NodeCard
            plain={plain}
            number={number}
            numberLabel={
                number !== undefined
                    ? t("automations.fields.triggerPosition", { number })
                    : undefined
            }
            kind={
                <flow.KindPicker
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
                <fields.DurationField
                    label={t("automations.fields.every")}
                    path={path}
                    field="minutes"
                    stored="minutes"
                    value={trigger.minutes}
                    disabled={disabled}
                    onChange={(minutes) => onChange({ ...trigger, minutes })}
                />
            )}
            {trigger.kind === "sun" && (
                <sun.SunTriggerFields
                    trigger={trigger}
                    path={path}
                    disabled={disabled}
                    onChange={onChange}
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
                    <fields.PlaceTargetField
                        block={trigger}
                        role="trigger"
                        path={path}
                        disabled={disabled}
                        onChange={onChange}
                    />
                    {!fields.placeValue(trigger) && (
                        <fields.TargetSetField
                            ids={auto.deviceTargets(trigger)}
                            devices={devices}
                            first={device}
                            role="trigger"
                            count={trigger.behaviour}
                            path={path}
                            disabled={disabled}
                            onChange={(ids, count) => onChange(setOf(trigger, ids, count))}
                        />
                    )}
                    {device && trigger.kind === "change" && (
                        <fields.WatchPicker
                            device={device}
                            value={{ attribute: trigger.attribute }}
                            path={path}
                            disabled={disabled}
                            onChange={(choice) =>
                                onChange(
                                    "figure" in choice
                                        ? {
                                              ...baseOf(trigger),
                                              id: trigger.id,
                                              kind: "threshold",
                                              deviceId: trigger.deviceId,
                                              direction: "above",
                                              value: Number.NaN,
                                              ...(choice.figure ? { measure: choice.figure } : {})
                                          }
                                        : {
                                              ...trigger,
                                              attribute: choice.attribute,
                                              from: "",
                                              to: ""
                                          }
                                )
                            }
                        />
                    )}
                    {device && trigger.kind === "stays" && (
                        <fields.AttributePicker
                            kind={device.kind}
                            device={device}
                            value={trigger.attribute}
                            path={path}
                            disabled={disabled}
                            onChange={(attribute) => onChange({ ...trigger, attribute, is: "" })}
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
                    {device &&
                        trigger.to &&
                        sameWord(fields.currentValue(device, trigger.attribute), trigger.to) && (
                            <p className="text-xs text-muted-foreground sm:col-span-2">
                                {t("automations.fields.alreadyThere", {
                                    value: words.valueText(
                                        trigger.attribute,
                                        device.kind,
                                        trigger.to,
                                        t
                                    )
                                })}
                            </p>
                        )}
                    <HeldFor node={trigger} path={path} disabled={disabled} onChange={onChange} />
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
                    <fields.DurationField
                        label={t("automations.fields.for")}
                        path={path}
                        field="minutes"
                        stored="minutes"
                        value={trigger.minutes}
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
                        onChange={(next) => onChange(auto.triggerOn(trigger, next))}
                    />
                    <fields.PlaceTargetField
                        block={trigger}
                        role="trigger"
                        path={path}
                        disabled={disabled}
                        onChange={onChange}
                    />
                    {!fields.placeValue(trigger) && (
                        <fields.TargetSetField
                            ids={auto.deviceTargets(trigger)}
                            devices={sensors}
                            first={device}
                            role="trigger"
                            count={trigger.behaviour}
                            path={path}
                            disabled={disabled}
                            onChange={(ids, count) => onChange(setOf(trigger, ids, count))}
                        />
                    )}
                    {device && (
                        <fields.WatchPicker
                            device={device}
                            value={{ figure: trigger.measure }}
                            path={path}
                            disabled={disabled}
                            onChange={(choice) => {
                                if ("attribute" in choice) {
                                    onChange({
                                        ...baseOf(trigger),
                                        id: trigger.id,
                                        kind: "change",
                                        deviceId: trigger.deviceId,
                                        attribute: choice.attribute,
                                        from: "",
                                        to: ""
                                    });
                                    return;
                                }
                                const { measure: _was, ...rest } = trigger;
                                onChange(
                                    choice.figure ? { ...rest, measure: choice.figure } : rest
                                );
                            }}
                        />
                    )}
                    <flow.Field
                        label={t("automations.fields.direction")}
                        path={[...path, "direction"]}
                    >
                        {(id) => (
                            <Select
                                id={id}
                                value={trigger.direction}
                                disabled={disabled}
                                options={
                                    trigger.measure === "quality"
                                        ? [
                                              {
                                                  value: "above",
                                                  label: t("automations.fields.worse")
                                              },
                                              {
                                                  value: "below",
                                                  label: t("automations.fields.better")
                                              }
                                          ]
                                        : auto.THRESHOLD_DIRECTIONS.map((value) => ({
                                              value,
                                              label: t(`automations.fields.${value}`)
                                          }))
                                }
                                onValueChange={(next) => {
                                    const direction = next as auto.ThresholdDirection;
                                    const { upper, ...rest } = trigger;
                                    onChange(
                                        auto.isRange(direction)
                                            ? { ...rest, direction, upper: upper ?? Number.NaN }
                                            : { ...rest, direction }
                                    );
                                }}
                            />
                        )}
                    </flow.Field>
                    <fields.FigureField
                        measure={trigger.measure}
                        label={t("automations.fields.value")}
                        path={path}
                        value={trigger.value}
                        suffix={fields.measureSuffix(trigger.measure, device?.reading?.unit)}
                        disabled={disabled}
                        onChange={(value) => onChange({ ...trigger, value })}
                    />
                    {auto.isRange(trigger.direction) && (
                        <fields.FigureField
                            measure={trigger.measure}
                            label={t("automations.fields.upper")}
                            path={path}
                            field="upper"
                            value={trigger.upper ?? Number.NaN}
                            suffix={fields.measureSuffix(trigger.measure, device?.reading?.unit)}
                            disabled={disabled}
                            onChange={(upper) => onChange({ ...trigger, upper })}
                        />
                    )}
                    <HeldFor node={trigger} path={path} disabled={disabled} onChange={onChange} />
                </>
            )}
        </flow.NodeCard>
    );
}

function ConditionGroupCard({
    group,
    path,
    devices,
    sensors,
    byId,
    disabled,
    plain,
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
    plain?: boolean;
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
        <div
            className={cn(
                "flex flex-col gap-2",
                !plain && "rounded-lg border border-dashed border-border p-2"
            )}
        >
            <div className="flex items-center gap-2">
                {group.items.length > 1 ? (
                    <flow.MatchPicker
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
                            ? () => onChange({ ...group, items: swap(group.items, index, -1) })
                            : undefined
                    }
                    onDown={
                        index < group.items.length - 1
                            ? () => onChange({ ...group, items: swap(group.items, index, 1) })
                            : undefined
                    }
                />
            ))}
            {group.items.length === 0 && attempted && (
                <p className="text-xs text-danger">{t("automations.errors.emptyGroup")}</p>
            )}
            {!disabled && group.items.length < auto.LIMITS.conditionsPerGroup && (
                <AddBlockButton
                    role="condition"
                    label={t("automations.editor.addToGroup")}
                    devices={devices}
                    onPick={(kind, target) =>
                        onChange({
                            ...group,
                            items: [...group.items, conditionFor(kind, target)]
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
        <flow.NodeCard
            kind={
                <flow.KindPicker
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
                        onChange={(next) => onChange(auto.conditionOn(condition, next))}
                    />
                    <fields.PlaceTargetField
                        block={condition}
                        role="condition"
                        path={path}
                        disabled={disabled}
                        onChange={onChange}
                    />
                    {!fields.placeValue(condition) && (
                        <fields.TargetSetField
                            ids={auto.deviceTargets(condition)}
                            devices={devices}
                            first={device}
                            role="condition"
                            count={condition.quantifier}
                            path={path}
                            disabled={disabled}
                            onChange={(ids, count) => onChange(setOf(condition, ids, count))}
                        />
                    )}
                    {device && (
                        <fields.WatchPicker
                            device={device}
                            value={{ attribute: condition.attribute }}
                            path={path}
                            disabled={disabled}
                            onChange={(choice) =>
                                onChange(
                                    "figure" in choice
                                        ? {
                                              ...baseOf(condition),
                                              id: condition.id,
                                              kind: "reading",
                                              deviceId: condition.deviceId,
                                              op: "gt",
                                              value: Number.NaN,
                                              ...(choice.figure ? { measure: choice.figure } : {})
                                          }
                                        : { ...condition, attribute: choice.attribute, is: "" }
                                )
                            }
                        />
                    )}
                    <flow.Field label={t("automations.fields.test")} path={[...path, "negate"]}>
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
                    </flow.Field>
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
                    <HeldFor node={condition} path={path} disabled={disabled} onChange={onChange} />
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
                        onChange={(next) => onChange(auto.conditionOn(condition, next))}
                    />
                    <fields.PlaceTargetField
                        block={condition}
                        role="condition"
                        path={path}
                        disabled={disabled}
                        onChange={onChange}
                    />
                    {!fields.placeValue(condition) && (
                        <fields.TargetSetField
                            ids={auto.deviceTargets(condition)}
                            devices={sensors}
                            first={device}
                            role="condition"
                            count={condition.quantifier}
                            path={path}
                            disabled={disabled}
                            onChange={(ids, count) => onChange(setOf(condition, ids, count))}
                        />
                    )}
                    {device && (
                        <fields.WatchPicker
                            device={device}
                            value={{ figure: condition.measure }}
                            path={path}
                            disabled={disabled}
                            onChange={(choice) => {
                                if ("attribute" in choice) {
                                    onChange({
                                        ...baseOf(condition),
                                        id: condition.id,
                                        kind: "device",
                                        deviceId: condition.deviceId,
                                        attribute: choice.attribute,
                                        is: "",
                                        negate: false
                                    });
                                    return;
                                }
                                const { measure: _was, ...rest } = condition;
                                onChange(
                                    choice.figure ? { ...rest, measure: choice.figure } : rest
                                );
                            }}
                        />
                    )}
                    <flow.Field label={t("automations.fields.compare")} path={[...path, "op"]}>
                        {(id) => (
                            <Select
                                id={id}
                                value={condition.op}
                                disabled={disabled}
                                options={auto.COMPARISONS.map((op) => ({
                                    value: op,
                                    label: words.comparisonText(op, t, condition.measure)
                                }))}
                                onValueChange={(next) => {
                                    const op = next as auto.Comparison;
                                    // A line has no top: one left over from a range
                                    // would be saved and never read.
                                    const { upper, ...rest } = condition;
                                    onChange(
                                        auto.isRangeTest(op)
                                            ? { ...rest, op, upper: upper ?? Number.NaN }
                                            : { ...rest, op }
                                    );
                                }}
                            />
                        )}
                    </flow.Field>
                    <fields.FigureField
                        measure={condition.measure}
                        label={t("automations.fields.value")}
                        path={path}
                        value={condition.value}
                        suffix={fields.measureSuffix(condition.measure, device?.reading?.unit)}
                        disabled={disabled}
                        onChange={(value) => onChange({ ...condition, value })}
                    />
                    {auto.isRangeTest(condition.op) && (
                        <fields.FigureField
                            measure={condition.measure}
                            label={t("automations.fields.upper")}
                            path={path}
                            field="upper"
                            value={condition.upper ?? Number.NaN}
                            suffix={fields.measureSuffix(condition.measure, device?.reading?.unit)}
                            disabled={disabled}
                            onChange={(upper) => onChange({ ...condition, upper })}
                        />
                    )}
                    <HeldFor node={condition} path={path} disabled={disabled} onChange={onChange} />
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
            {condition.kind === "sun" && (
                <sun.SunConditionFields
                    condition={condition}
                    path={path}
                    disabled={disabled}
                    onChange={onChange}
                />
            )}
            {condition.kind === "triggeredBy" && (
                <sun.TriggeredByFields
                    condition={condition}
                    path={path}
                    disabled={disabled}
                    onChange={onChange}
                />
            )}
            {condition.kind === "weekday" && (
                <fields.DaysPicker
                    path={path}
                    days={condition.days}
                    disabled={disabled}
                    onChange={(days) => onChange({ ...condition, days })}
                />
            )}
        </flow.NodeCard>
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
    plain,
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
    plain?: boolean;
    onChange: (step: auto.Step) => void;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
}) {
    const t = usePlacesT();
    const device = "deviceId" in step ? byId.get(step.deviceId) : undefined;
    return (
        <flow.NodeCard
            plain={plain}
            number={number}
            kind={
                <flow.KindPicker
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
                        onChange={(next) => onChange(auto.stepOn(step, next))}
                    />
                    <fields.PlaceTargetField
                        block={step}
                        path={path}
                        disabled={disabled}
                        onChange={onChange}
                    />
                    {!fields.placeValue(step) && (
                        <fields.TargetSetField
                            ids={auto.deviceTargets(step)}
                            devices={operableDevices}
                            first={device}
                            role="step"
                            count={undefined}
                            path={path}
                            disabled={disabled}
                            onChange={(ids) => onChange(setOf(step, ids, undefined))}
                        />
                    )}
                    <flow.Field label={t("automations.fields.do")} path={[...path, "do"]}>
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
                                onValueChange={(next) => {
                                    const action = next as auto.StepDeviceAction;
                                    onChange({
                                        ...step,
                                        do: action,
                                        setting: auto.blankSetting(action, device?.climate, {
                                            kind: device?.kind ?? "",
                                            settings: device?.air
                                        })
                                    });
                                }}
                            />
                        )}
                    </flow.Field>
                    {step.setting && (
                        <fields.SettingFields
                            device={device}
                            setting={step.setting}
                            path={path}
                            disabled={disabled}
                            onChange={(setting) => onChange({ ...step, setting })}
                        />
                    )}
                </>
            )}
            {step.kind === "delay" && (
                <fields.DurationField
                    label={t("automations.fields.wait")}
                    path={path}
                    field="seconds"
                    value={step.seconds}
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
                        onChange={(next) => onChange(auto.stepOn(step, next))}
                    />
                    <fields.PlaceTargetField
                        block={step}
                        role="condition"
                        path={path}
                        disabled={disabled}
                        onChange={onChange}
                    />
                    {!fields.placeValue(step) && (
                        <fields.TargetSetField
                            ids={auto.deviceTargets(step)}
                            devices={watched}
                            first={device}
                            role="condition"
                            count={step.quantifier}
                            path={path}
                            disabled={disabled}
                            onChange={(ids, count) => onChange(setOf(step, ids, count))}
                        />
                    )}
                    {device && (
                        <fields.AttributePicker
                            kind={device.kind}
                            device={device}
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
                    <fields.DurationField
                        label={t("automations.fields.giveUp")}
                        path={path}
                        field="timeoutMinutes"
                        stored="minutes"
                        value={step.timeoutMinutes}
                        disabled={disabled}
                        onChange={(timeoutMinutes) => onChange({ ...step, timeoutMinutes })}
                    />
                    <flow.Field
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
                    </flow.Field>
                </>
            )}
            {step.kind === "notify" && (
                <flow.Field
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
                </flow.Field>
            )}
            {step.kind === "run" && (
                <flow.Field
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
                </flow.Field>
            )}
        </flow.NodeCard>
    );
}

/** The optional "for at least" a block can carry: emptied, the block has none
 *  and happens - or passes - the moment it is so. */
function HeldFor<T extends { forMinutes?: number }>({
    node,
    path,
    disabled,
    onChange
}: {
    node: T;
    path: readonly (string | number)[];
    disabled: boolean;
    onChange: (node: T) => void;
}) {
    const t = usePlacesT();
    return (
        <fields.DurationField
            label={t("automations.fields.forMinutes")}
            path={path}
            field="forMinutes"
            stored="minutes"
            required={false}
            value={node.forMinutes ?? Number.NaN}
            disabled={disabled}
            onChange={(minutes) => {
                const { forMinutes: _was, ...rest } = node;
                onChange((Number.isNaN(minutes) ? rest : { ...rest, forMinutes: minutes }) as T);
            }}
        />
    );
}

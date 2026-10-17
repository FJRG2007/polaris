"use client";

/**
 * The canvas view of the editor: the board, the node palette, the side panel
 * that configures the selected node with the same fields as the list view,
 * and the keys (copy, paste, delete, undo) that act on the selection.
 */

import * as core from "@polaris/core";
import { ReferenceScope } from "./references";
import { Copy, CopyPlus, PanelRight, Pencil, Pin, PinOff, Play, Power, PowerOff, Trash2, X } from "lucide-react";
import type { SecretSummary } from "@/lib/automations/secrets";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CanvasBoard, NO_SELECTION, type CanvasSelection } from "./canvas-board";
import { NodeFields, STEP_TYPES, TRIGGER_TYPES, configValid, newNode, type T } from "./node-fields";
import { nodeTitle } from "../shared";
import {
    Button,
    ContextMenuGroup,
    ContextMenuItem,
    ContextMenuSeparator,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Input,
    MenuShortcut,
    Select,
    Switch,
    Textarea,
    useToast
} from "@polaris/ui";

type Change = (update: (graph: core.AutomationGraph) => core.AutomationGraph, options?: { group?: boolean }) => void;

/** What a node says under its name: the part of its settings a reader scans for. */
export function nodeSubtitle(t: T, node: core.GraphNode): string | null {
    const config = (node.config ?? {}) as Record<string, unknown>;
    if (node.alias) return nodeTitle(t, node.type);
    if (node.type === "core.http") return `${String(config.method ?? "")} ${config.urlSecretId ? t("fields.urlFromSecret") : String(config.url ?? "")}`.trim();
    if (node.type === "core.notify" || node.type === "core.chat") return typeof config.title === "string" && config.title ? config.title : null;
    if (node.type === "core.schedule" && config.kind === "cron") return String(config.expression ?? "");
    return null;
}

export function nodeLabel(t: T, node: core.GraphNode | undefined): string {
    return node ? node.alias || nodeTitle(t, node.type) : t("nodes.unknown");
}

/** Anything copied on this page when the system clipboard is out of reach (no permission, an insecure origin). */
let pageClipboard: string | null = null;

export function CanvasEditor({
    graph,
    change,
    undo,
    redo,
    readOnly,
    detail,
    secrets,
    samples,
    states,
    onChanged,
    onRunFrom
}: {
    graph: core.AutomationGraph;
    change: Change;
    undo: () => void;
    redo: () => void;
    readOnly: boolean;
    detail: AutomationDetail;
    secrets: SecretSummary[];
    samples: Readonly<Record<string, unknown>>;
    states?: Readonly<Record<string, string>>;
    onChanged: () => void;
    /** Start a test that really runs this node and what follows, with data standing in for what comes before. */
    onRunFrom?: (nodeId: string) => void;
}) {
    const t = useTranslations("automations");
    const toast = useToast();
    const [selection, setSelection] = useState<CanvasSelection>(NO_SELECTION);
    const [panel, setPanel] = useState<string | null>(null);
    const [palette, setPalette] = useState(false);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [insertOn, setInsertOn] = useState<string | null>(null);
    const [refit, setRefit] = useState(0);
    const placeAt = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    const refuse = (code: core.ConnectRefusal) => toast.show({ title: t(`canvas.refusals.${code}`) });
    const panelNode = panel ? graph.nodes.find((node) => node.id === panel) : undefined;

    const copy = async (cut: boolean) => {
        if (selection.nodes.size === 0 && selection.notes.size === 0) return;
        const text = core.fragmentText(core.copyFragment(graph, selection.nodes, selection.notes));
        pageClipboard = text;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // The page copy above is enough to paste here.
        }
        if (cut) remove();
        toast.show({ title: t("canvas.copied") });
    };

    const paste = async (at: { x: number; y: number }) => {
        let text = pageClipboard;
        try {
            const read = await navigator.clipboard.readText();
            if (core.parseFragment(read)) text = read;
        } catch {
            // No permission to read: whatever this page copied still pastes.
        }
        const fragment = text ? core.parseFragment(text) : null;
        if (!fragment || fragment.nodes.length + fragment.notes.length === 0) return void toast.show({ title: t("canvas.nothingToPaste") });
        const origin = core.graphBounds({ ...core.emptyGraph(), nodes: fragment.nodes, notes: fragment.notes }) ?? { x: 0, y: 0 };
        const pasted = core.pasteFragment(graph, fragment, { x: Math.round(at.x - origin.x), y: Math.round(at.y - origin.y) }, core.automationNodeId);
        if (!pasted) return void toast.show({ title: t("canvas.pasteTooMany") });
        change(() => pasted.graph, { group: false });
        setSelection({ nodes: new Set(pasted.nodeIds), notes: new Set(pasted.noteIds), edge: null });
    };

    const remove = () => {
        if (selection.edge) {
            const key = selection.edge;
            change((current) => core.disconnect(current, key), { group: false });
        } else if (selection.nodes.size || selection.notes.size) {
            change((current) => core.removeFromGraph(current, selection.nodes, selection.notes), { group: false });
            if (panel && selection.nodes.has(panel)) setPanel(null);
        }
        setSelection(NO_SELECTION);
    };

    const duplicate = () => {
        const fragment = core.copyFragment(graph, selection.nodes, selection.notes);
        if (fragment.nodes.length + fragment.notes.length === 0) return;
        const pasted = core.pasteFragment(graph, fragment, { x: 32, y: 32 }, core.automationNodeId);
        if (!pasted) return void toast.show({ title: t("canvas.pasteTooMany") });
        change(() => pasted.graph, { group: false });
        setSelection({ nodes: new Set(pasted.nodeIds), notes: new Set(pasted.noteIds), edge: null });
    };

    /** Switch the chosen steps off, or back on when every one of them is already off. Triggers have no switch. */
    const toggleEnabled = (ids: ReadonlySet<string>) => {
        const steps = graph.nodes.filter((node) => ids.has(node.id) && core.nodeRole(node.type) !== "trigger");
        if (steps.length === 0) return;
        const on = steps.every((node) => node.enabled === false);
        const touched = new Set(steps.map((node) => node.id));
        change((current) => ({ ...current, nodes: current.nodes.map((node) => (touched.has(node.id) ? { ...node, enabled: on ? undefined : false } : node)) }), { group: false });
    };

    /** Pin the last test output, or unpin. With nothing to pin yet, the panel opens where a sample can be written. */
    const togglePin = (node: core.GraphNode) => {
        if (!core.canPin(node.type)) return;
        const sample = samples[node.id];
        if (node.pinned === undefined && (sample === undefined || sample === null)) {
            setPanel(node.id);
            return void toast.show({ title: t("canvas.noSampleToPin") });
        }
        const pinned = node.pinned === undefined ? sample : undefined;
        change((current) => ({ ...current, nodes: current.nodes.map((entry) => (entry.id === node.id ? { ...entry, pinned } : entry)) }), { group: false });
        toast.show({ title: pinned === undefined ? t("canvas.unpinned") : t("canvas.pinSaved") });
    };

    const single = () => (selection.nodes.size === 1 ? graph.nodes.find((node) => selection.nodes.has(node.id)) : undefined);

    const lanes = useMemo(() => core.lanesOf(graph), [graph]);

    const nodeMenu = (node: core.GraphNode) => {
        const runnable = onRunFrom && (core.nodeRole(node.type) === "trigger" || lanes.get(node.id) === "main");
        const ids = selection.nodes.has(node.id) ? selection.nodes : new Set([node.id]);
        const steps = graph.nodes.filter((entry) => ids.has(entry.id) && core.nodeRole(entry.type) !== "trigger");
        const turnOn = steps.length > 0 && steps.every((entry) => entry.enabled === false);
        return (
            <>
                <ContextMenuGroup>
                    <ContextMenuItem onSelect={() => setPanel(node.id)}>
                        <PanelRight aria-hidden="true" />
                        {t("canvas.menu.open")}
                        <MenuShortcut keys="Enter" />
                    </ContextMenuItem>
                    {!readOnly ? (
                        <ContextMenuItem onSelect={() => setRenaming(node.id)}>
                            <Pencil aria-hidden="true" />
                            {t("canvas.menu.rename")}
                            {/* i18n-ignore: a key on the keyboard */}
                            <MenuShortcut>F2</MenuShortcut>
                        </ContextMenuItem>
                    ) : null}
                </ContextMenuGroup>
                {!readOnly ? (
                    <>
                        {core.canPin(node.type) || runnable ? (
                            <>
                                <ContextMenuSeparator />
                                <ContextMenuGroup>
                                    {runnable ? (
                                        <ContextMenuItem onSelect={() => onRunFrom(node.id)}>
                                            <Play aria-hidden="true" />
                                            {t("canvas.menu.runFromHere")}
                                        </ContextMenuItem>
                                    ) : null}
                                    {core.canPin(node.type) ? <ContextMenuItem onSelect={() => togglePin(node)}>
                                        {node.pinned !== undefined ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                                        {node.pinned !== undefined ? t("canvas.unpin") : t("canvas.menu.pin")}
                                        {/* i18n-ignore: a key on the keyboard */}
                                        <MenuShortcut>P</MenuShortcut>
                                    </ContextMenuItem> : null}
                                </ContextMenuGroup>
                            </>
                        ) : null}
                        <ContextMenuSeparator />
                        <ContextMenuGroup>
                            <ContextMenuItem onSelect={duplicate}>
                                <CopyPlus aria-hidden="true" />
                                {t("canvas.menu.duplicate")}
                                <MenuShortcut keys="Mod+D" />
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => void copy(false)}>
                                <Copy aria-hidden="true" />
                                {t("canvas.menu.copy")}
                                <MenuShortcut keys="Mod+C" />
                            </ContextMenuItem>
                            {steps.length > 0 ? (
                                <ContextMenuItem onSelect={() => toggleEnabled(ids)}>
                                    {turnOn ? <Power aria-hidden="true" /> : <PowerOff aria-hidden="true" />}
                                    {turnOn ? t("canvas.menu.enable") : t("canvas.menu.disable")}
                                    {/* i18n-ignore: a key on the keyboard */}
                                    <MenuShortcut>D</MenuShortcut>
                                </ContextMenuItem>
                            ) : null}
                        </ContextMenuGroup>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="danger" onSelect={remove}>
                            <Trash2 aria-hidden="true" />
                            {ids.size > 1 ? t("canvas.menu.deleteMany", { count: ids.size }) : t("canvas.menu.delete")}
                            <MenuShortcut keys="Delete" />
                        </ContextMenuItem>
                    </>
                ) : null}
            </>
        );
    };

    const tidy = () => {
        change((current) => core.layoutGraph(current, { tidy: true }), { group: false });
        setRefit((count) => count + 1);
        toast.show({ title: t("canvas.tidied") });
    };

    const addNode = (type: string) => {
        if (graph.nodes.length >= core.AUTOMATION_LIMITS.nodes) return void toast.show({ title: t("canvas.pasteTooMany") });
        if (insertOn) {
            const node = newNode(type);
            const inserted = core.insertOnEdge(graph, insertOn, node);
            setInsertOn(null);
            if (!inserted) return void toast.show({ title: t("canvas.insertGone") });
            change(() => inserted, { group: false });
            setSelection({ nodes: new Set([node.id]), notes: new Set(), edge: null });
            setPanel(node.id);
            return;
        }
        const node = { ...newNode(type), position: { x: Math.round(placeAt.current.x - core.CANVAS_NODE.width / 2), y: Math.round(placeAt.current.y - core.CANVAS_NODE.height / 2) } };
        change((current) => ({ ...current, nodes: [...current.nodes, node] }), { group: false });
        setSelection({ nodes: new Set([node.id]), notes: new Set(), edge: null });
        setPanel(node.id);
    };

    const addNote = (at: { x: number; y: number }) => {
        if (graph.notes.length >= core.AUTOMATION_LIMITS.notes) return;
        const note: core.GraphNote = { id: core.automationNodeId(), text: "", position: { x: Math.round(at.x - 110), y: Math.round(at.y - 60) }, size: { width: 220, height: 120 } };
        change((current) => ({ ...current, notes: [...current.notes, note] }), { group: false });
        setSelection({ nodes: new Set(), notes: new Set([note.id]), edge: null });
    };

    const onKey = (event: KeyboardEvent<HTMLDivElement>, center: () => { x: number; y: number }): boolean => {
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (mod && key === "z" && !readOnly) event.shiftKey ? redo() : undo();
        else if (mod && key === "y" && !readOnly) redo();
        else if (mod && key === "a") setSelection({ nodes: new Set(graph.nodes.map((node) => node.id)), notes: new Set(graph.notes.map((note) => note.id)), edge: null });
        else if (mod && key === "c") void copy(false);
        else if (mod && key === "x" && !readOnly) void copy(true);
        else if (mod && key === "v" && !readOnly) void paste(center());
        else if (mod && key === "d" && !readOnly) duplicate();
        else if (key === "d" && !mod && !event.shiftKey && !readOnly && selection.nodes.size > 0) toggleEnabled(selection.nodes);
        else if (key === "p" && !mod && !event.shiftKey && !readOnly && single()) togglePin(single()!);
        else if (key === "f2" && !readOnly && single()) setRenaming(single()!.id);
        else if ((key === "delete" || key === "backspace") && !readOnly) remove();
        else if (key === "n" && !mod && !readOnly && !event.shiftKey) {
            placeAt.current = center();
            setInsertOn(null);
            setPalette(true);
        } else if (key === "s" && event.shiftKey && !mod && !readOnly) addNote(center());
        else if (key === "t" && event.shiftKey && event.altKey && !mod && !readOnly) tidy();
        else if (key === "enter" && selection.nodes.size === 1) setPanel([...selection.nodes][0]!);
        else return false;
        event.preventDefault();
        return true;
    };

    return (
        <div className="flex h-[calc(100dvh-14rem)] min-h-[28rem] flex-col gap-3 lg:flex-row">
            <div className="min-h-0 min-w-0 flex-1">
                <CanvasBoard
                    graph={graph}
                    readOnly={readOnly}
                    selection={selection}
                    onSelect={(next) => {
                        setSelection(next);
                        if (next.nodes.size === 1) setPanel([...next.nodes][0]!);
                    }}
                    onChange={change}
                    onOpen={setPanel}
                    onInsert={(edgeKey) => {
                        setInsertOn(edgeKey);
                        setPalette(true);
                    }}
                    onTidy={tidy}
                    refit={refit}
                    onPalette={() => {
                        setInsertOn(null);
                        placeAt.current = { x: (core.graphBounds(graph)?.x ?? 0) + (core.graphBounds(graph)?.width ?? 0) + 120, y: core.graphBounds(graph)?.y ?? 0 };
                        setPalette(true);
                    }}
                    onAddNote={addNote}
                    onRefused={refuse}
                    onKey={onKey}
                    title={(node) => nodeLabel(t, node)}
                    subtitle={(node) => nodeSubtitle(t, node)}
                    incomplete={(node) => !configValid(node)}
                    states={states}
                    menu={nodeMenu}
                />
            </div>
            {panelNode ? (
                <aside className="flex max-h-[60vh] min-h-0 w-full shrink-0 flex-col rounded-lg border border-border bg-card lg:max-h-none lg:w-[24rem]" aria-label={t("canvas.settings")}>
                    <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
                        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={nodeLabel(t, panelNode)}>
                            {nodeLabel(t, panelNode)}
                        </h2>
                        <Button variant="ghost" size="icon-sm" aria-label={t("canvas.closePanel")} title={t("canvas.closePanel")} onClick={() => setPanel(null)}>
                            <X aria-hidden="true" />
                        </Button>
                    </header>
                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3">
                        <NodePanel
                            key={panelNode.id}
                            node={panelNode}
                            graph={graph}
                            change={change}
                            readOnly={readOnly}
                            detail={detail}
                            secrets={secrets}
                            sample={samples[panelNode.id]}
                            onChanged={onChanged}
                            onRemove={() => {
                                change((current) => core.removeFromGraph(current, [panelNode.id]), { group: false });
                                setPanel(null);
                                setSelection(NO_SELECTION);
                            }}
                        />
                    </div>
                </aside>
            ) : null}
            <RenameDialog
                node={renaming ? graph.nodes.find((node) => node.id === renaming) : undefined}
                onClose={() => setRenaming(null)}
                onRename={(nodeId, alias) =>
                    change((current) => ({ ...current, nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, alias } : node)) }), { group: false })
                }
            />
            <Palette open={palette} stepsOnly={insertOn !== null} onOpenChange={(open) => {
                setPalette(open);
                if (!open) setInsertOn(null);
            }} onPick={(type) => {
                setPalette(false);
                addNode(type);
            }} />
        </div>
    );
}

function RenameDialog({ node, onClose, onRename }: { node: core.GraphNode | undefined; onClose: () => void; onRename: (nodeId: string, alias: string | undefined) => void }) {
    const t = useTranslations("automations");
    const [value, setValue] = useState("");
    const [shownFor, setShownFor] = useState<string | null>(null);
    if (node && shownFor !== node.id) {
        setShownFor(node.id);
        setValue(node.alias ?? "");
    }
    const close = () => {
        setShownFor(null);
        onClose();
    };
    const save = () => {
        if (!node) return;
        const alias = value.trim() || undefined;
        if (alias !== node.alias) onRename(node.id, alias);
        close();
    };
    return (
        <Dialog open={Boolean(node)} onOpenChange={(open) => !open && close()}>
            <DialogContent className="max-w-sm">
                <DialogTitle>{t("canvas.menu.renameTitle")}</DialogTitle>
                <DialogDescription>{t("canvas.menu.renameHint")}</DialogDescription>
                <Input
                    autoFocus
                    value={value}
                    maxLength={80}
                    aria-label={t("canvas.alias")}
                    placeholder={node ? nodeTitle(t, node.type) : undefined}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            save();
                        }
                    }}
                />
                <DialogFooter>
                    <Button variant="ghost" onClick={close}>
                        {t("canvas.cancel")}
                    </Button>
                    <Button onClick={save}>{t("canvas.menu.renameSave")}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Palette({ open, stepsOnly, onOpenChange, onPick }: { open: boolean; stepsOnly: boolean; onOpenChange: (open: boolean) => void; onPick: (type: string) => void }) {
    const t = useTranslations("automations");
    const [query, setQuery] = useState("");
    const groups = [
        ...(stepsOnly ? [] : [{ label: t("canvas.groupTriggers"), types: TRIGGER_TYPES as readonly string[] }]),
        { label: t("canvas.groupSteps"), types: STEP_TYPES as readonly string[] }
    ];
    const needle = query.trim().toLowerCase();
    const shown = groups
        .map((group) => ({ ...group, types: group.types.filter((type) => !needle || nodeTitle(t, type).toLowerCase().includes(needle) || type.includes(needle)) }))
        .filter((group) => group.types.length > 0);
    const first = shown[0]?.types[0];
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) setQuery("");
            }}
        >
            <DialogContent className="max-w-md">
                <DialogTitle>{stepsOnly ? t("canvas.insertTitle") : t("canvas.paletteTitle")}</DialogTitle>
                <DialogDescription>{t("canvas.paletteHint")}</DialogDescription>
                <Input
                    autoFocus
                    value={query}
                    placeholder={t("canvas.searchNodes")}
                    aria-label={t("canvas.searchNodes")}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && first) {
                            event.preventDefault();
                            event.stopPropagation();
                            onPick(first);
                        }
                    }}
                />
                <div className="max-h-80 space-y-3 overflow-y-auto overscroll-contain">
                    {shown.length === 0 ? <p className="text-sm text-muted-foreground">{t("canvas.noMatches")}</p> : null}
                    {shown.map((group) => (
                        <div key={group.label} className="space-y-1">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">{group.label}</p>
                            {group.types.map((type) => (
                                <button
                                    key={type}
                                    type="button"
                                    className="flex w-full min-w-0 items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted"
                                    onClick={() => onPick(type)}
                                >
                                    <span className="truncate">{nodeTitle(t, type)}</span>
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function NodePanel({
    node,
    graph,
    change,
    readOnly,
    detail,
    secrets,
    sample,
    onChanged,
    onRemove
}: {
    node: core.GraphNode;
    graph: core.AutomationGraph;
    change: Change;
    readOnly: boolean;
    detail: AutomationDetail;
    secrets: SecretSummary[];
    sample: unknown;
    onChanged: () => void;
    onRemove: () => void;
}) {
    const t = useTranslations("automations");
    const toast = useToast();
    const [pinText, setPinText] = useState<string | null>(null);
    const set = (update: Partial<core.GraphNode>) =>
        change((current) => ({ ...current, nodes: current.nodes.map((entry) => (entry.id === node.id ? { ...entry, ...update } : entry)) }));
    const role = core.nodeRole(node.type);
    const ports = core.nodePorts(node.type);
    const byId = useMemo(() => new Map(graph.nodes.map((entry) => [entry.id, entry])), [graph.nodes]);
    const shownSample = node.pinned !== undefined ? node.pinned : sample;
    const pinJson = (() => {
        try {
            return pinText === null ? null : JSON.parse(pinText);
        } catch {
            return undefined;
        }
    })();
    const pinTooLarge = pinText !== null && core.byteLength(pinText) > core.AUTOMATION_LIMITS.pinBytes;

    return (
        <>
            <fieldset disabled={readOnly} className="space-y-3">
                <label className="block space-y-1 text-sm">
                    <span>{t("canvas.alias")}</span>
                    <Input value={node.alias ?? ""} maxLength={80} placeholder={nodeTitle(t, node.type)} onChange={(event) => set({ alias: event.target.value || undefined })} />
                </label>
                <ReferenceScope nodeId={node.id}>
                    <NodeFields node={node} setConfig={(config) => set({ config })} detail={detail} secrets={secrets} onChanged={onChanged} />
                </ReferenceScope>
                {role === "action" ? (
                    <label className="block space-y-1 text-sm">
                        <span>{t("editor.ifFails")}</span>
                        <Select
                            value={node.onError ?? "stop"}
                            onValueChange={(value) => set({ onError: value as "stop" | "continue" })}
                            options={[
                                { value: "stop", label: t("editor.onErrorStop") },
                                { value: "continue", label: t("editor.onErrorContinue") }
                            ]}
                            aria-label={t("editor.ifFails")}
                        />
                    </label>
                ) : null}
                {role !== "trigger" ? (
                    <label className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0">{t("canvas.enabled")}</span>
                        <Switch checked={node.enabled !== false} aria-label={t("canvas.enabled")} onChange={(on: boolean) => set({ enabled: on ? undefined : false })} />
                    </label>
                ) : null}
                <label className="block space-y-1 text-sm">
                    <span>{t("canvas.note")}</span>
                    <Textarea rows={2} maxLength={250} value={node.note ?? ""} onChange={(event) => set({ note: event.target.value || undefined })} />
                </label>
            </fieldset>

            <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle">{t("canvas.connections")}</h3>
                {ports.map((port) => {
                    const targets = graph.edges.filter((edge) => edge.from.node === node.id && edge.from.port === port);
                    const options = graph.nodes
                        .filter((entry) => core.connectRefusal(graph, { node: node.id, port }, entry.id) === null)
                        .map((entry) => ({ value: entry.id, label: nodeLabel(t, entry) }));
                    return (
                        <div key={port} className="space-y-1">
                            {ports.length > 1 ? <p className="text-xs text-muted-foreground">{t(`canvas.ports.${port === "then" ? "then" : port === "else" ? "else" : "next"}`)}</p> : null}
                            {targets.map((edge) => (
                                <div key={core.edgeKey(edge)} className="flex min-w-0 items-center gap-2 text-sm">
                                    <span className="min-w-0 flex-1 truncate" title={nodeLabel(t, byId.get(edge.to.node))}>
                                        {nodeLabel(t, byId.get(edge.to.node))}
                                    </span>
                                    {!readOnly ? (
                                        <Button variant="ghost" size="icon-sm" aria-label={t("canvas.removeEdge")} title={t("canvas.removeEdge")} onClick={() => change((current) => core.disconnect(current, core.edgeKey(edge)), { group: false })}>
                                            <X aria-hidden="true" />
                                        </Button>
                                    ) : null}
                                </div>
                            ))}
                            {!readOnly ? (
                                options.length ? (
                                    <Select
                                        value=""
                                        placeholder={t("canvas.connectTo")}
                                        options={options}
                                        aria-label={t("canvas.connectTo")}
                                        onValueChange={(target) => change((current) => core.connect(current, { node: node.id, port }, target), { group: false })}
                                    />
                                ) : (
                                    <p className="text-xs text-foreground-subtle">{t("canvas.noTargets")}</p>
                                )
                            ) : null}
                        </div>
                    );
                })}
            </section>

            {!readOnly && role !== "trigger" ? <AlwaysLane node={node} graph={graph} change={change} /> : null}

            {core.canPin(node.type) ? (
                <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle">{node.pinned !== undefined ? t("canvas.pinnedSample") : t("canvas.lastOutput")}</h3>
                    {pinText !== null ? (
                        <>
                            <Textarea rows={8} className="font-mono text-xs" aria-label={t("canvas.editPin")} value={pinText} aria-invalid={pinJson === undefined || pinTooLarge ? true : undefined} onChange={(event) => setPinText(event.target.value)} />
                            {pinJson === undefined ? <p className="text-xs text-danger">{t("canvas.pinInvalid")}</p> : pinTooLarge ? <p className="text-xs text-danger">{t("canvas.pinTooLarge")}</p> : null}
                            <div className="flex flex-wrap justify-end gap-2">
                                <Button variant="ghost" size="sm" onClick={() => setPinText(null)}>
                                    {t("canvas.cancel")}
                                </Button>
                                <Button
                                    size="sm"
                                    disabled={pinJson === undefined || pinTooLarge}
                                    onClick={() => {
                                        set({ pinned: pinJson });
                                        setPinText(null);
                                        toast.show({ title: t("canvas.pinSaved") });
                                    }}
                                >
                                    {t("canvas.savePin")}
                                </Button>
                            </div>
                        </>
                    ) : shownSample !== undefined && shownSample !== null ? (
                        <pre className="max-h-64 overflow-auto overscroll-contain rounded-md bg-field p-2 font-mono text-xs">{JSON.stringify(shownSample, null, 2)}</pre>
                    ) : (
                        <p className="text-xs text-muted-foreground">{t("canvas.noOutput")}</p>
                    )}
                    {!readOnly && pinText === null ? (
                        <div className="flex flex-wrap gap-2">
                            {node.pinned === undefined && sample !== undefined && sample !== null ? (
                                <Button variant="outline" size="sm" onClick={() => set({ pinned: sample })}>
                                    <Pin aria-hidden="true" />
                                    {t("canvas.pin")}
                                </Button>
                            ) : null}
                            <Button variant="outline" size="sm" onClick={() => setPinText(JSON.stringify(shownSample ?? {}, null, 2))}>
                                {t("canvas.editPin")}
                            </Button>
                            {node.pinned !== undefined ? (
                                <Button variant="ghost" size="sm" onClick={() => set({ pinned: undefined })}>
                                    <PinOff aria-hidden="true" />
                                    {t("canvas.unpin")}
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                    <p className="text-xs text-foreground-subtle">{t("canvas.pinHint")}</p>
                </section>
            ) : null}

            {!readOnly ? (
                <Button variant="outline" size="sm" className="w-full" onClick={onRemove}>
                    <Trash2 aria-hidden="true" />
                    {t("editor.remove")}
                </Button>
            ) : null}
        </>
    );
}

/** Start the Always lane at this node, or take it out: the panel's way to do what dragging from the lane's dot does. */
function AlwaysLane({ node, graph, change }: { node: core.GraphNode; graph: core.AutomationGraph; change: Change }) {
    const t = useTranslations("automations");
    const starts = graph.finally.entry === node.id;
    const refusal = starts ? null : core.connectRefusal(graph, { node: core.FINALLY_SOURCE, port: "next" }, node.id);
    if (!starts && refusal !== null) return null;
    return (
        <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle">{t("editor.always")}</h3>
            {starts ? <p className="text-xs text-muted-foreground">{t("canvas.alwaysStarts")}</p> : null}
            <Button
                variant="outline"
                size="sm"
                onClick={() =>
                    change(
                        (current) =>
                            starts ? core.disconnect(current, `${core.FINALLY_SOURCE}>${node.id}`) : core.connect(current, { node: core.FINALLY_SOURCE, port: "next" }, node.id),
                        { group: false }
                    )
                }
            >
                {starts ? t("canvas.alwaysLeave") : t("canvas.alwaysStartHere")}
            </Button>
        </section>
    );
}

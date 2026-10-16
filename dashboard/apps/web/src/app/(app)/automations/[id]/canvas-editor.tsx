"use client";

/**
 * The canvas view of the editor: the board, the node palette, the side panel
 * that configures the selected node with the same fields as the list view,
 * and the keys (copy, paste, delete, undo) that act on the selection.
 */

import * as core from "@polaris/core";
import { ReferenceScope } from "./references";
import { Pin, PinOff, Trash2, X } from "lucide-react";
import type { SecretSummary } from "@/lib/automations/secrets";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CanvasBoard, NO_SELECTION, type CanvasSelection } from "./canvas-board";
import { NodeFields, STEP_TYPES, TRIGGER_TYPES, configValid, newNode, type T } from "./node-fields";
import { nodeTitle } from "../shared";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Select, Switch, Textarea, useToast } from "@polaris/ui";

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
    onChanged
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
}) {
    const t = useTranslations("automations");
    const toast = useToast();
    const [selection, setSelection] = useState<CanvasSelection>(NO_SELECTION);
    const [panel, setPanel] = useState<string | null>(null);
    const [palette, setPalette] = useState(false);
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

    const addNode = (type: string) => {
        if (graph.nodes.length >= core.AUTOMATION_LIMITS.nodes) return void toast.show({ title: t("canvas.pasteTooMany") });
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
        else if (mod && key === "d" && !readOnly) {
            const fragment = core.copyFragment(graph, selection.nodes, selection.notes);
            const pasted = core.pasteFragment(graph, fragment, { x: 32, y: 32 }, core.automationNodeId);
            if (pasted) {
                change(() => pasted.graph, { group: false });
                setSelection({ nodes: new Set(pasted.nodeIds), notes: new Set(pasted.noteIds), edge: null });
            }
        } else if ((key === "delete" || key === "backspace") && !readOnly) remove();
        else if (key === "n" && !mod && !readOnly && !event.shiftKey) {
            placeAt.current = center();
            setPalette(true);
        } else if (key === "s" && event.shiftKey && !mod && !readOnly) addNote(center());
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
                    onPalette={() => {
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
                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
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
            <Palette open={palette} onOpenChange={setPalette} onPick={(type) => {
                setPalette(false);
                addNode(type);
            }} />
        </div>
    );
}

function Palette({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (type: string) => void }) {
    const t = useTranslations("automations");
    const [query, setQuery] = useState("");
    const groups = [
        { label: t("canvas.groupTriggers"), types: TRIGGER_TYPES as readonly string[] },
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
                <DialogTitle>{t("canvas.paletteTitle")}</DialogTitle>
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
                <div className="max-h-80 space-y-3 overflow-y-auto">
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
                        <pre className="max-h-64 overflow-auto rounded-md bg-field p-2 font-mono text-xs">{JSON.stringify(shownSample, null, 2)}</pre>
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

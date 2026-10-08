"use client";

/**
 * A scope's variables - one service's, or an environment's shared ones - edited
 * in place and saved as one batch.
 *
 * Edits are held here until Save, and only the difference is sent: a secret
 * nobody typed over is never sent back (see `variable-changes.ts`). Save and
 * Save and redeploy are separate, so several changes cost one redeploy, and a
 * change saved without one says so and offers it until it happens.
 *
 * A reference variable (`${{postgres.DATABASE_URL}}`) is marked linked, with
 * what it points at - or a warning when nothing in the environment answers to
 * it, which is the deploy that would otherwise be refused later.
 *
 * Laid out the way Railway's is. Every value is masked until its eye is
 * pressed, and can be shown and copied from its row by anybody who may read
 * the variables, a secret included (fetched on request, which the server
 * writes down). Editing, secrecy, sharing with every service and removing are
 * behind the row's menu. The list can be searched, and the raw editor
 * (`variables-raw-dialog.tsx`) shows the whole set as a .env or as JSON.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import type { EnvVarView } from "@/lib/env-var-service";
import type { VariableLink } from "@/lib/deploy/variable-links";
import { VariablesRawDialog } from "./variables-raw-dialog";
import { stageReplacement } from "@/lib/deploy/variable-raw";
import { listEnvVarsAction, revealEnvVarAction } from "./actions";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
    cn,
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Switch,
    shortcutPressed
} from "@polaris/ui";
import {
    promoteEnvVarAction,
    redeployEnvScopeAction,
    saveEnvVarChangesAction,
    variableLinksAction
} from "./variable-actions";
import {
    Check,
    Copy,
    Eye,
    EyeOff,
    Link2,
    Loader2,
    Lock,
    LockOpen,
    MoreVertical,
    Pencil,
    Plus,
    RotateCw,
    Search,
    Share2,
    TriangleAlert,
    Trash2,
    Undo2,
    X
} from "lucide-react";
import {
    changeCount,
    draftErrors,
    EMPTY_DRAFT,
    valueChanged,
    variableChanges,
    type VariableDraft
} from "@/lib/deploy/variable-changes";

type Scope = "application" | "environment";

const NO_ROWS: EnvVarView[] = [];

/** A masked value placeholder: fixed-width dots, so secrets never render as text. */
function SecretMask() {
    const t = useTranslations("deployConfig");
    return (
        <span
            role="img"
            className="inline-flex items-center gap-0.5 align-middle"
            aria-label={t("variables.hiddenValue")}
        >
            {Array.from({ length: 8 }).map((_, index) => (
                <span key={index} className="size-1 rounded-full bg-muted-foreground/50" />
            ))}
        </span>
    );
}

function LinkBadge({ link }: { link: VariableLink }) {
    const t = useTranslations("deployConfig");
    if (!link.target) {
        return (
            <Badge variant="warning" title={link.written}>
                <TriangleAlert className="size-3" />{" "}
                {t("variables.link.missing", { name: link.name })}
            </Badge>
        );
    }
    if (!link.keyKnown) {
        return (
            <Badge variant="warning" title={link.written}>
                <TriangleAlert className="size-3" />{" "}
                {t("variables.link.noKey", { target: link.target.label, key: link.key })}
            </Badge>
        );
    }
    return (
        <Badge variant="primary" title={link.written}>
            <Link2 className="size-3" />{" "}
            {t("variables.link.linked", { target: link.target.label, key: link.key })}
        </Badge>
    );
}

/** The icon buttons of a row, at the size and colour every one of them shares. */
const ICON_BUTTON =
    "rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

export function VariablesEditor({
    scope,
    scopeId,
    canWrite,
    canDeploy,
    redeployTarget,
    onConfigureShared
}: {
    scope: Scope;
    scopeId: string;
    canWrite: boolean;
    canDeploy: boolean;
    /** What a redeploy reaches, in words: "this service", "the services in Production". */
    redeployTarget: string;
    /** Opens the environment's shared variables. A service's editor offers it
     *  under its list, as Railway does; absent, nothing is offered. */
    onConfigureShared?: () => void;
}) {
    const t = useTranslations("deployConfig");
    const [rows, setRows] = useState<EnvVarView[] | null>(null);
    const [links, setLinks] = useState<Record<string, VariableLink[]>>({});
    const [draft, setDraft] = useState<VariableDraft>(EMPTY_DRAFT);
    // Values shown on request, by id. A secret only reaches the page when it is asked for.
    const [revealed, setRevealed] = useState<Record<string, string>>({});
    // Every value as the raw editor last read it: what its text is compared with.
    const [known, setKnown] = useState<Record<string, string>>({});
    const [editing, setEditing] = useState<ReadonlySet<string>>(new Set());
    const [query, setQuery] = useState("");
    const [rawOpen, setRawOpen] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<"pending" | "redeploying" | null>(null);
    const [pending, startTransition] = useTransition();
    const counter = useRef(0);
    // The row the pointer is over, for F2: an editor's rename key works on what
    // is under the hand as much as on what was clicked.
    const hovered = useRef<EnvVarView | null>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const editHovered = useRef<(row: EnvVarView) => Promise<void>>(async () => {});
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nextId = () => `new-${++counter.current}`;

    function load(): void {
        void listEnvVarsAction(scope, scopeId)
            .then(setRows)
            .catch(() => setRows([]));
        void variableLinksAction({ scope, scopeId })
            .then(setLinks)
            .catch(() => setLinks({}));
    }

    useEffect(() => {
        setRows(null);
        setDraft(EMPTY_DRAFT);
        setRevealed({});
        setKnown({});
        setEditing(new Set());
        setQuery("");
        setNotice(null);
        setError(null);
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope, scopeId]);

    useEffect(
        () => () => {
            if (copyTimer.current) clearTimeout(copyTimer.current);
        },
        []
    );

    useEffect(() => {
        if (!canWrite) return;
        function onKey(event: KeyboardEvent): void {
            if (event.defaultPrevented || !hovered.current || !shortcutPressed(event, "general.rename")) return;
            const target = event.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
            if (
                target !== document.body &&
                !(target instanceof Node && listRef.current?.contains(target))
            )
                return;
            event.preventDefault();
            void editHovered.current(hovered.current);
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [canWrite]);

    const list = rows ?? NO_ROWS;
    const compared = useMemo(() => ({ ...known, ...revealed }), [known, revealed]);
    const changes = useMemo(() => variableChanges(list, draft, compared), [list, draft, compared]);
    const count = changeCount(changes);
    const errors = useMemo(() => draftErrors(list, draft), [list, draft]);
    const blocked = pending || Object.keys(errors).length > 0;
    const wanted = query.trim().toLowerCase();
    const visible = wanted ? list.filter((row) => row.key.toLowerCase().includes(wanted)) : list;

    function edit(id: string, patch: { value?: string; isSecret?: boolean }): void {
        setDraft((current) => ({
            ...current,
            edits: { ...current.edits, [id]: { ...current.edits[id], ...patch } }
        }));
    }

    function toggleRemoved(id: string): void {
        setDraft((current) => ({
            ...current,
            removed: current.removed.includes(id)
                ? current.removed.filter((one) => one !== id)
                : [...current.removed, id]
        }));
    }

    function patchAdded(
        tempId: string,
        patch: Partial<{ key: string; value: string; isSecret: boolean }>
    ): void {
        setDraft((current) => ({
            ...current,
            added: current.added.map((item) =>
                item.tempId === tempId ? { ...item, ...patch } : item
            )
        }));
    }

    function addRow(): void {
        setDraft((current) => ({
            ...current,
            added: [...current.added, { tempId: nextId(), key: "", value: "", isSecret: true }]
        }));
    }

    /** A row's value: what is on screen, what the raw editor read, the listed
     *  one, or - for a secret nobody asked for yet - from the server. */
    async function valueOf(row: EnvVarView): Promise<string | null> {
        const held = revealed[row.id] ?? known[row.id];
        if (held !== undefined) return held;
        if (!row.isSecret) return row.value ?? "";
        setBusy(row.id);
        try {
            const result = await revealEnvVarAction(row.id);
            if (typeof result.value === "string") return result.value;
            if (result.error) setError(result.error);
            return null;
        } finally {
            setBusy(null);
        }
    }

    async function toggleReveal(row: EnvVarView): Promise<void> {
        if (row.id in revealed) {
            setRevealed((current) => {
                const next = { ...current };
                delete next[row.id];
                return next;
            });
            return;
        }
        const value = await valueOf(row);
        if (value !== null) setRevealed((current) => ({ ...current, [row.id]: value }));
    }

    async function copyValue(row: EnvVarView): Promise<void> {
        const value = await valueOf(row);
        if (value === null || !navigator.clipboard) return;
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            return;
        }
        setCopied(row.id);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), 1500);
    }

    /** Edit a row in place: a secret is read first, so it is edited as it is. */
    async function startEditing(row: EnvVarView): Promise<void> {
        if (!canWrite || draft.removed.includes(row.id)) return;
        const value = await valueOf(row);
        if (value === null) return;
        setRevealed((current) => ({ ...current, [row.id]: value }));
        setEditing((current) => new Set(current).add(row.id));
    }
    editHovered.current = startEditing;

    /** Leave a row's box: Enter keeps what was typed, Escape puts it back. */
    function stopEditing(id: string, keep: boolean): void {
        if (!keep)
            setDraft((current) => {
                const held = current.edits[id];
                if (!held || held.value === undefined) return current;
                const edits = { ...current.edits };
                const { value: _dropped, ...rest } = held;
                if (Object.keys(rest).length > 0) edits[id] = rest;
                else delete edits[id];
                return { ...current, edits };
            });
        setEditing((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
        });
    }

    function promote(row: EnvVarView): void {
        setError(null);
        startTransition(async () => {
            const result = await promoteEnvVarAction({ id: row.id }).catch(() => ({
                error: t("variables.promoteFailed"),
                key: undefined
            }));
            if (result.error) {
                setError(result.error);
                return;
            }
            setDraft((current) => {
                const edits = { ...current.edits };
                delete edits[row.id];
                return {
                    ...current,
                    edits,
                    removed: current.removed.filter((id) => id !== row.id)
                };
            });
            setEditing((current) => {
                const next = new Set(current);
                next.delete(row.id);
                return next;
            });
            for (const forget of [setRevealed, setKnown])
                forget((current) => {
                    const next = { ...current };
                    delete next[row.id];
                    return next;
                });
            setNotice("pending");
            load();
        });
    }

    function stageRaw(
        entries: Parameters<typeof stageReplacement>[2],
        values: Readonly<Record<string, string>>,
        newAreSecrets: boolean
    ): void {
        setError(null);
        setKnown((current) => ({ ...current, ...values }));
        setDraft((current) => stageReplacement(list, current, entries, newAreSecrets, nextId));
        setRawOpen(false);
    }

    function save(redeploy: boolean): void {
        setError(null);
        startTransition(async () => {
            const result = await saveEnvVarChangesAction({
                scope,
                scopeId,
                ...changes,
                redeploy
            }).catch(() => ({
                error: t("variables.saveFailed"),
                redeployed: false
            }));
            if (result.error) {
                setError(result.error);
                return;
            }
            setDraft(EMPTY_DRAFT);
            setRevealed({});
            setKnown({});
            setEditing(new Set());
            setNotice(result.redeployed ? "redeploying" : "pending");
            load();
        });
    }

    function redeployNow(): void {
        setError(null);
        startTransition(async () => {
            const result = await redeployEnvScopeAction({ scope, scopeId }).catch(() => ({
                error: t("variables.redeployFailed")
            }));
            if (result.error) setError(result.error);
            else setNotice("redeploying");
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                    {t("variables.count", { count: rows ? rows.length : 0 })}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={rows === null}
                        onClick={() => setRawOpen(true)}
                    >
                        {t("variables.rawEditor")}
                    </Button>
                    {canWrite && (
                        <Button size="sm" onClick={addRow}>
                            <Plus className="size-4" /> {t("variables.newVariable")}
                        </Button>
                    )}
                </div>
            </div>
            {list.length > 0 && (
                <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("variables.search")}
                        aria-label={t("variables.search")}
                        className="h-8 pl-8 text-xs"
                    />
                </div>
            )}
            <p className="text-xs text-muted-foreground">
                {t.rich("variables.referencesHint", {
                    service: "${{postgres.DATABASE_URL}}",
                    shared: "${{shared.KEY}}",
                    code: (chunks) => (
                        <code key={String(chunks)} className="font-mono">
                            {chunks}
                        </code>
                    )
                })}
            </p>

            {notice === "pending" && (
                <div
                    role="status"
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning-edge bg-warning-soft px-3 py-2"
                >
                    <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
                        {t("variables.savedPending", { target: redeployTarget })}
                    </p>
                    {canDeploy && (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={pending}
                            onClick={redeployNow}
                        >
                            <RotateCw className="size-4" /> {t("variables.redeployNow")}
                        </Button>
                    )}
                </div>
            )}
            {notice === "redeploying" && (
                <p role="status" className="text-xs text-success-ink">
                    {t("variables.savedRedeploying", { target: redeployTarget })}
                </p>
            )}

            {rows === null ? (
                <div className="flex justify-center py-6 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                </div>
            ) : rows.length === 0 && draft.added.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                    {canWrite ? t("variables.emptyWritable") : t("variables.empty")}
                </p>
            ) : (
                <ul ref={listRef} className="flex flex-col">
                    {draft.added.map((item) => (
                        <li
                            key={item.tempId}
                            className="flex flex-col gap-2 border-b border-border py-2.5 sm:flex-row sm:items-start sm:gap-3"
                        >
                            <div className="flex min-w-0 flex-col gap-1 sm:w-56 sm:shrink-0">
                                <Input
                                    value={item.key}
                                    onChange={(event) =>
                                        patchAdded(item.tempId, { key: event.target.value })
                                    }
                                    onBlur={(event) =>
                                        patchAdded(item.tempId, { key: event.target.value.trim() })
                                    }
                                    // i18n-ignore: a variable name placeholder
                                    placeholder="KEY"
                                    aria-label={t("variables.name")}
                                    aria-invalid={errors[item.tempId] ? true : undefined}
                                    className="h-8 font-mono text-xs"
                                    autoFocus
                                />
                                {errors[item.tempId] && (
                                    <span className="text-[0.6875rem] text-danger-ink">
                                        {errors[item.tempId]}
                                    </span>
                                )}
                            </div>
                            <Input
                                value={item.value}
                                onChange={(event) =>
                                    patchAdded(item.tempId, { value: event.target.value })
                                }
                                placeholder={t("variables.valuePlaceholder")}
                                aria-label={t("variables.valueOf", {
                                    name: item.key || t("variables.theNewVariable")
                                })}
                                className="h-8 min-w-0 flex-1 font-mono text-xs"
                            />
                            <div className="flex shrink-0 items-center gap-2 sm:h-8">
                                <Badge variant="primary">{t("variables.new")}</Badge>
                                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <Switch
                                        checked={item.isSecret}
                                        onChange={(isSecret) =>
                                            patchAdded(item.tempId, { isSecret })
                                        }
                                        aria-label={t("variables.secret")}
                                    />
                                    {t("variables.secret")}
                                </label>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setDraft((current) => ({
                                            ...current,
                                            added: current.added.filter(
                                                (one) => one.tempId !== item.tempId
                                            )
                                        }))
                                    }
                                    aria-label={t("variables.dropNew")}
                                    className={ICON_BUTTON}
                                >
                                    <X className="size-4" />
                                </button>
                            </div>
                        </li>
                    ))}
                    {visible.length === 0 && (
                        <li className="py-4 text-center text-sm text-muted-foreground">
                            {t("variables.noMatch")}
                        </li>
                    )}
                    {visible.map((row) => {
                        const change = draft.edits[row.id];
                        const removed = draft.removed.includes(row.id);
                        const isSecret = change?.isSecret ?? row.isSecret;
                        const shown = revealed[row.id];
                        const changed =
                            !removed &&
                            (valueChanged(row, change?.value, compared) ||
                                isSecret !== row.isSecret);
                        const inPlace =
                            canWrite &&
                            !removed &&
                            (editing.has(row.id) || change?.value !== undefined);
                        const rowLinks = links[row.id];
                        return (
                            <li
                                key={row.id}
                                tabIndex={canWrite && !removed ? -1 : undefined}
                                onMouseEnter={() => {
                                    hovered.current = row;
                                }}
                                onMouseLeave={() => {
                                    if (hovered.current?.id === row.id) hovered.current = null;
                                }}
                                onKeyDown={(event) => {
                                    if (!canWrite || removed || !shortcutPressed(event, "general.rename")) return;
                                    event.preventDefault();
                                    void startEditing(row);
                                }}
                                className="group flex flex-col gap-2 border-b border-border py-2.5 outline-none focus-visible:bg-card-hover sm:flex-row sm:items-center sm:gap-3"
                            >
                                <div className="flex min-w-0 flex-col gap-1 sm:w-56 sm:shrink-0">
                                    <span className="flex min-w-0 items-center gap-1.5">
                                        {(changed || removed) && (
                                            <span
                                                role="img"
                                                aria-label={
                                                    removed
                                                        ? t("variables.removedOnSave")
                                                        : t("variables.changedUnsaved")
                                                }
                                                className={cn(
                                                    "size-1.5 shrink-0 rounded-full",
                                                    removed ? "bg-danger-solid" : "bg-primary"
                                                )}
                                            />
                                        )}
                                        <span
                                            className={cn(
                                                "truncate font-mono text-xs font-medium",
                                                removed && "text-muted-foreground line-through"
                                            )}
                                            title={row.key}
                                        >
                                            {row.key}
                                        </span>
                                        {isSecret && (
                                            <Lock
                                                className="size-3 shrink-0 text-foreground-subtle"
                                                aria-label={t("variables.isSecret", {
                                                    name: row.key
                                                })}
                                            />
                                        )}
                                    </span>
                                    {rowLinks && rowLinks.length > 0 && (
                                        <span className="flex flex-wrap gap-1">
                                            {rowLinks.map((link) => (
                                                <LinkBadge key={link.written} link={link} />
                                            ))}
                                        </span>
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    {inPlace ? (
                                        <Input
                                            value={change?.value ?? shown ?? row.value ?? ""}
                                            onChange={(event) =>
                                                edit(row.id, { value: event.target.value })
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") {
                                                    event.preventDefault();
                                                    stopEditing(row.id, true);
                                                } else if (event.key === "Escape") {
                                                    event.preventDefault();
                                                    stopEditing(row.id, false);
                                                }
                                            }}
                                            onDoubleClick={() => void startEditing(row)}
                                            placeholder={t("variables.valuePlaceholder")}
                                            aria-label={t("variables.valueOf", { name: row.key })}
                                            className="h-8 font-mono text-xs"
                                            autoFocus={editing.has(row.id)}
                                        />
                                    ) : (
                                        <span
                                            className={cn(
                                                "block truncate font-mono text-xs text-muted-foreground",
                                                canWrite && !removed && "cursor-text"
                                            )}
                                            onDoubleClick={() => void startEditing(row)}
                                            title={
                                                canWrite && !removed
                                                    ? [shown, t("variables.editHint")]
                                                          .filter(Boolean)
                                                          .join("\n\n")
                                                    : shown
                                            }
                                        >
                                            {shown !== undefined ? (
                                                shown || (
                                                    <span className="text-foreground-subtle">
                                                        {t("variables.emptyValue")}
                                                    </span>
                                                )
                                            ) : (
                                                <SecretMask />
                                            )}
                                        </span>
                                    )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    {!removed && (
                                        <div className="flex items-center gap-1 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0">
                                            <button
                                                type="button"
                                                onClick={() => void toggleReveal(row)}
                                                disabled={busy === row.id}
                                                aria-label={
                                                    shown !== undefined
                                                        ? t("variables.hideValueOf", {
                                                              name: row.key
                                                          })
                                                        : t("variables.showValueOf", {
                                                              name: row.key
                                                          })
                                                }
                                                title={
                                                    shown !== undefined
                                                        ? t("variables.hide")
                                                        : t("variables.reveal")
                                                }
                                                className={ICON_BUTTON}
                                            >
                                                {shown !== undefined ? (
                                                    <EyeOff className="size-3.5" />
                                                ) : (
                                                    <Eye className="size-3.5" />
                                                )}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void copyValue(row)}
                                                disabled={busy === row.id}
                                                aria-label={t("variables.copyValueOf", {
                                                    name: row.key
                                                })}
                                                title={t("variables.copy")}
                                                className={ICON_BUTTON}
                                            >
                                                {copied === row.id ? (
                                                    <Check className="size-3.5 text-success-ink" />
                                                ) : (
                                                    <Copy className="size-3.5" />
                                                )}
                                            </button>
                                        </div>
                                    )}
                                    {canWrite && removed && (
                                        <button
                                            type="button"
                                            onClick={() => toggleRemoved(row.id)}
                                            aria-label={t("variables.keepNamed", { name: row.key })}
                                            title={t("variables.keep")}
                                            className={ICON_BUTTON}
                                        >
                                            <Undo2 className="size-4" />
                                        </button>
                                    )}
                                    {canWrite && !removed && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button
                                                    type="button"
                                                    aria-label={t("variables.actionsFor", {
                                                        name: row.key
                                                    })}
                                                    title={t("variables.actions")}
                                                    className={ICON_BUTTON}
                                                >
                                                    <MoreVertical className="size-4" />
                                                </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem
                                                    onSelect={() => void startEditing(row)}
                                                >
                                                    <Pencil /> {t("variables.edit")}
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    onSelect={() =>
                                                        edit(row.id, { isSecret: !isSecret })
                                                    }
                                                >
                                                    {isSecret ? <LockOpen /> : <Lock />}
                                                    {isSecret
                                                        ? t("variables.makePlain")
                                                        : t("variables.makeSecret")}
                                                </DropdownMenuItem>
                                                {scope === "application" && (
                                                    <DropdownMenuItem
                                                        disabled={pending}
                                                        onSelect={() => promote(row)}
                                                    >
                                                        <Share2 /> {t("variables.promote")}
                                                    </DropdownMenuItem>
                                                )}
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    variant="danger"
                                                    onSelect={() => toggleRemoved(row.id)}
                                                >
                                                    <Trash2 /> {t("variables.remove")}
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {scope === "application" && onConfigureShared && rows !== null && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border px-3 py-2.5">
                    <div className="min-w-0 flex-1 basis-56">
                        <p className="text-sm font-medium">{t("variables.sync.title")}</p>
                        <p className="text-xs text-muted-foreground">{t("variables.sync.body")}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={onConfigureShared}>
                        {t("variables.sync.configure")}
                    </Button>
                </div>
            )}

            {error && <p className="text-sm text-danger-ink">{error}</p>}

            {canWrite && (count > 0 || draft.added.length > 0) && (
                <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border-strong bg-elevated px-3 py-2 shadow-popover">
                    <span className="text-sm">{t("variables.unsaved", { count })}</span>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => {
                                setDraft(EMPTY_DRAFT);
                                setEditing(new Set());
                            }}
                        >
                            {t("variables.discard")}
                        </Button>
                        <Button
                            variant={canDeploy ? "outline" : "primary"}
                            size="sm"
                            disabled={blocked || count === 0}
                            onClick={() => save(false)}
                        >
                            {pending ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                t("variables.save")
                            )}
                        </Button>
                        {canDeploy && (
                            <Button
                                size="sm"
                                disabled={blocked || count === 0}
                                onClick={() => save(true)}
                                title={t("variables.saveRedeployTitle", { target: redeployTarget })}
                            >
                                {t("variables.saveRedeploy")}
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {rawOpen && (
                <VariablesRawDialog
                    scope={scope}
                    scopeId={scopeId}
                    rows={list}
                    draft={draft}
                    canWrite={canWrite}
                    onClose={() => setRawOpen(false)}
                    onUpdate={stageRaw}
                />
            )}
        </div>
    );
}

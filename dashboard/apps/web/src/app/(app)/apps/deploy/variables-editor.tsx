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
 */

import { parseDotEnv } from "@/lib/deploy/dotenv";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { EnvVarView } from "@/lib/env-var-service";
import type { VariableLink } from "@/lib/deploy/variable-links";
import { listEnvVarsAction, revealEnvVarAction } from "./actions";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { cn, Badge, Button, Checkbox, Input, Switch, Textarea } from "@polaris/ui";
import { redeployEnvScopeAction, saveEnvVarChangesAction, variableLinksAction } from "./variable-actions";
import { Eye, EyeOff, Link2, Loader2, Pencil, Plus, RotateCw, TriangleAlert, Trash2, Undo2, X } from "lucide-react";
import {
    changeCount,
    draftErrors,
    EMPTY_DRAFT,
    stageDotEnv,
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
        <span role="img" className="inline-flex items-center gap-0.5 align-middle" aria-label={t("variables.hiddenValue")}>
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
                <TriangleAlert className="size-3" /> {t("variables.link.missing", { name: link.name })}
            </Badge>
        );
    }
    if (!link.keyKnown) {
        return (
            <Badge variant="warning" title={link.written}>
                <TriangleAlert className="size-3" /> {t("variables.link.noKey", { target: link.target.label, key: link.key })}
            </Badge>
        );
    }
    return (
        <Badge variant="primary" title={link.written}>
            <Link2 className="size-3" /> {t("variables.link.linked", { target: link.target.label, key: link.key })}
        </Badge>
    );
}

export function VariablesEditor({
    scope,
    scopeId,
    canWrite,
    canDeploy,
    redeployTarget
}: {
    scope: Scope;
    scopeId: string;
    canWrite: boolean;
    canDeploy: boolean;
    /** What a redeploy reaches, in words: "this service", "the services in Production". */
    redeployTarget: string;
}) {
    const t = useTranslations("deployConfig");
    const [rows, setRows] = useState<EnvVarView[] | null>(null);
    const [links, setLinks] = useState<Record<string, VariableLink[]>>({});
    const [draft, setDraft] = useState<VariableDraft>(EMPTY_DRAFT);
    // Values revealed on request, by id. A secret only reaches the page when its eye is pressed.
    const [revealed, setRevealed] = useState<Record<string, string>>({});
    const [rawOpen, setRawOpen] = useState(false);
    const [raw, setRaw] = useState("");
    const [rawSecret, setRawSecret] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<"pending" | "redeploying" | null>(null);
    const [pending, startTransition] = useTransition();
    const counter = useRef(0);
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
        setNotice(null);
        setError(null);
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope, scopeId]);

    const list = rows ?? NO_ROWS;
    const changes = useMemo(() => variableChanges(list, draft, revealed), [list, draft, revealed]);
    const count = changeCount(changes);
    const errors = useMemo(() => draftErrors(list, draft), [list, draft]);
    const blocked = pending || Object.keys(errors).length > 0;

    function edit(id: string, patch: { value?: string; isSecret?: boolean }): void {
        setDraft((current) => ({ ...current, edits: { ...current.edits, [id]: { ...current.edits[id], ...patch } } }));
    }

    function toggleRemoved(id: string): void {
        setDraft((current) => ({
            ...current,
            removed: current.removed.includes(id)
                ? current.removed.filter((one) => one !== id)
                : [...current.removed, id]
        }));
    }

    function patchAdded(tempId: string, patch: Partial<{ key: string; value: string; isSecret: boolean }>): void {
        setDraft((current) => ({
            ...current,
            added: current.added.map((item) => (item.tempId === tempId ? { ...item, ...patch } : item))
        }));
    }

    function addRow(): void {
        setDraft((current) => ({
            ...current,
            added: [...current.added, { tempId: nextId(), key: "", value: "", isSecret: true }]
        }));
    }

    function toggleReveal(row: EnvVarView): void {
        if (row.id in revealed) {
            setRevealed((current) => {
                const next = { ...current };
                delete next[row.id];
                return next;
            });
            return;
        }
        if (!row.isSecret) {
            setRevealed((current) => ({ ...current, [row.id]: row.value ?? "" }));
            return;
        }
        void revealEnvVarAction(row.id).then((result) => {
            if (typeof result.value === "string") {
                setRevealed((current) => ({ ...current, [row.id]: result.value as string }));
                // A Replace opened and left empty gives way to the value now on screen.
                setDraft((current) => {
                    const { value, ...rest } = current.edits[row.id] ?? {};
                    if (value !== "") return current;
                    return { ...current, edits: { ...current.edits, [row.id]: rest } };
                });
            } else if (result.error) setError(result.error);
        });
    }

    function stageRaw(): void {
        const parsed = parseDotEnv(raw);
        if (parsed.length === 0) {
            setError(t("variables.noLines"));
            return;
        }
        setError(null);
        setDraft((current) => stageDotEnv(list, current, parsed, rawSecret, nextId));
        setRaw("");
        setRawOpen(false);
    }

    function save(redeploy: boolean): void {
        setError(null);
        startTransition(async () => {
            const result = await saveEnvVarChangesAction({ scope, scopeId, ...changes, redeploy }).catch(() => ({
                error: t("variables.saveFailed"),
                redeployed: false
            }));
            if (result.error) {
                setError(result.error);
                return;
            }
            setDraft(EMPTY_DRAFT);
            setRevealed({});
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
                {canWrite && (
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setRawOpen((open) => !open)}>
                            {t("variables.rawEditor")}
                        </Button>
                        <Button size="sm" onClick={addRow}>
                            <Plus className="size-4" /> {t("variables.newVariable")}
                        </Button>
                    </div>
                )}
            </div>
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
                        <Button size="sm" variant="outline" disabled={pending} onClick={redeployNow}>
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

            {rawOpen && (
                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <span className="text-xs font-medium text-muted-foreground">
                        {t("variables.rawHint")}
                    </span>
                    <Textarea
                        value={raw}
                        onChange={(event) => setRaw(event.target.value)}
                        rows={6}
                        spellCheck={false}
                        // i18n-ignore: an example .env
                        placeholder={'DATABASE_URL="postgres://user:pass@host:5432/db"\nexport NODE_ENV=production'}
                        className="font-mono text-xs"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-3">
                            <label className="cursor-pointer text-xs text-primary hover:underline">
                                {t("variables.upload")}
                                <input
                                    type="file"
                                    accept=".env,text/plain"
                                    className="hidden"
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        if (file) void file.text().then((text) => setRaw((prev) => (prev ? `${prev}\n${text}` : text)));
                                    }}
                                />
                            </label>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Checkbox checked={rawSecret} onChange={(event) => setRawSecret(event.target.checked)} />
                                {t("variables.newAreSecrets")}
                            </label>
                        </div>
                        <Button size="sm" onClick={stageRaw} disabled={!raw.trim()}>
                            {t("variables.addToChanges")}
                        </Button>
                    </div>
                </div>
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
                <ul className="flex flex-col">
                    {draft.added.map((item) => (
                        <li
                            key={item.tempId}
                            className="flex flex-col gap-2 border-b border-border py-2.5 sm:flex-row sm:items-start sm:gap-3"
                        >
                            <div className="flex min-w-0 flex-col gap-1 sm:w-56 sm:shrink-0">
                                <Input
                                    value={item.key}
                                    onChange={(event) => patchAdded(item.tempId, { key: event.target.value })}
                                    onBlur={(event) => patchAdded(item.tempId, { key: event.target.value.trim() })}
                                    // i18n-ignore: a variable name placeholder
                                    placeholder="KEY"
                                    aria-label={t("variables.name")}
                                    aria-invalid={errors[item.tempId] ? true : undefined}
                                    className="h-8 font-mono text-xs"
                                    autoFocus
                                />
                                {errors[item.tempId] && (
                                    <span className="text-[0.6875rem] text-danger-ink">{errors[item.tempId]}</span>
                                )}
                            </div>
                            <Input
                                value={item.value}
                                onChange={(event) => patchAdded(item.tempId, { value: event.target.value })}
                                placeholder={t("variables.valuePlaceholder")}
                                aria-label={t("variables.valueOf", { name: item.key || t("variables.theNewVariable") })}
                                className="h-8 min-w-0 flex-1 font-mono text-xs"
                            />
                            <div className="flex shrink-0 items-center gap-2 sm:h-8">
                                <Badge variant="primary">{t("variables.new")}</Badge>
                                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <Switch
                                        checked={item.isSecret}
                                        onChange={(isSecret) => patchAdded(item.tempId, { isSecret })}
                                        aria-label={t("variables.secret")}
                                    />
                                    {t("variables.secret")}
                                </label>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setDraft((current) => ({
                                            ...current,
                                            added: current.added.filter((one) => one.tempId !== item.tempId)
                                        }))
                                    }
                                    aria-label={t("variables.dropNew")}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    <X className="size-4" />
                                </button>
                            </div>
                        </li>
                    ))}
                    {rows.map((row) => {
                        const change = draft.edits[row.id];
                        const removed = draft.removed.includes(row.id);
                        const isSecret = change?.isSecret ?? row.isSecret;
                        const shown = revealed[row.id];
                        const changed = !removed && (valueChanged(row, change?.value, revealed) || isSecret !== row.isSecret);
                        const editing = canWrite && !removed && (!row.isSecret || shown !== undefined || change?.value !== undefined);
                        const rowLinks = links[row.id];
                        return (
                            <li
                                key={row.id}
                                className="group flex flex-col gap-2 border-b border-border py-2.5 sm:flex-row sm:items-center sm:gap-3"
                            >
                                <div className="flex min-w-0 flex-col gap-1 sm:w-56 sm:shrink-0">
                                    <span className="flex min-w-0 items-center gap-1.5">
                                        {(changed || removed) && (
                                            <span
                                                role="img"
                                                aria-label={removed ? t("variables.removedOnSave") : t("variables.changedUnsaved")}
                                                className={cn("size-1.5 shrink-0 rounded-full", removed ? "bg-danger-solid" : "bg-primary")}
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
                                    {editing ? (
                                        <Input
                                            value={change?.value ?? (row.isSecret ? (shown ?? "") : (row.value ?? ""))}
                                            onChange={(event) => edit(row.id, { value: event.target.value })}
                                            type={row.isSecret && shown === undefined ? "password" : "text"}
                                            placeholder={
                                                row.isSecret && shown === undefined
                                                    ? t("variables.newValuePlaceholder")
                                                    : t("variables.valuePlaceholder")
                                            }
                                            aria-label={t("variables.valueOf", { name: row.key })}
                                            className="h-8 font-mono text-xs"
                                        />
                                    ) : (
                                        <span className="block truncate font-mono text-xs text-muted-foreground">
                                            {shown !== undefined ? (
                                                shown || <span className="text-foreground-subtle">{t("variables.emptyValue")}</span>
                                            ) : row.isSecret ? (
                                                <SecretMask />
                                            ) : (
                                                row.value || <span className="text-foreground-subtle">{t("variables.emptyValue")}</span>
                                            )}
                                        </span>
                                    )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    {canWrite && !removed && (
                                        <label className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                            <Switch
                                                checked={isSecret}
                                                onChange={(next) => edit(row.id, { isSecret: next })}
                                                aria-label={t("variables.isSecret", { name: row.key })}
                                            />
                                            {t("variables.secret")}
                                        </label>
                                    )}
                                    {row.isSecret && canWrite && !removed && !editing && (
                                        <button
                                            type="button"
                                            onClick={() => edit(row.id, { value: "" })}
                                            aria-label={t("variables.replaceValueOf", { name: row.key })}
                                            title={t("variables.replace")}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        >
                                            <Pencil className="size-3.5" />
                                        </button>
                                    )}
                                    {row.isSecret && !removed && (
                                        <button
                                            type="button"
                                            onClick={() => toggleReveal(row)}
                                            aria-label={
                                                shown !== undefined
                                                    ? t("variables.hideNamed", { name: row.key })
                                                    : t("variables.revealNamed", { name: row.key })
                                            }
                                            title={shown !== undefined ? t("variables.hide") : t("variables.reveal")}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        >
                                            {shown !== undefined ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                        </button>
                                    )}
                                    {canWrite && (
                                        <button
                                            type="button"
                                            onClick={() => toggleRemoved(row.id)}
                                            aria-label={
                                                removed
                                                    ? t("variables.keepNamed", { name: row.key })
                                                    : t("variables.removeNamed", { name: row.key })
                                            }
                                            title={removed ? t("variables.keep") : t("variables.remove")}
                                            className={cn(
                                                "rounded p-1 text-muted-foreground transition-colors hover:bg-muted",
                                                removed ? "hover:text-foreground" : "hover:text-danger-ink"
                                            )}
                                        >
                                            {removed ? <Undo2 className="size-4" /> : <Trash2 className="size-4" />}
                                        </button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {error && <p className="text-sm text-danger-ink">{error}</p>}

            {canWrite && (count > 0 || draft.added.length > 0) && (
                <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border-strong bg-elevated px-3 py-2 shadow-popover">
                    <span className="text-sm">
                        {t("variables.unsaved", { count })}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setDraft(EMPTY_DRAFT)}>
                            {t("variables.discard")}
                        </Button>
                        <Button
                            variant={canDeploy ? "outline" : "primary"}
                            size="sm"
                            disabled={blocked || count === 0}
                            onClick={() => save(false)}
                        >
                            {pending ? <Loader2 className="size-4 animate-spin" /> : t("variables.save")}
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
        </div>
    );
}

"use client";

/**
 * Polar's own "/" commands: the list each person keeps, the form that writes
 * one (shortcut, prompt, model for prompt) and the dialog that manages them.
 *
 * The form checks a shortcut with the schema the route checks it with, so a
 * refusal is shown while typing rather than after Save. The list is cached
 * per browser and read again behind it, so the "/" list has the commands
 * before the request answers.
 */

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Textarea,
    useToast
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    ModelSelector,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import * as polarShared from "@/lib/polar/shared";
import type { CommandShortcutIssue, ModelChoice, PolarCommandRow } from "@/lib/polar/shared";

const CACHE_KEY = "polar.commands";

function readCache(): PolarCommandRow[] | null {
    try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return Array.isArray(parsed) ? (parsed as PolarCommandRow[]) : null;
    } catch {
        return null;
    }
}

function writeCache(rows: PolarCommandRow[]): void {
    try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(rows));
    } catch {
        // A private window: the list is read from the server each time.
    }
}

const byShortcut = (a: PolarCommandRow, b: PolarCommandRow) =>
    a.shortcut < b.shortcut ? -1 : a.shortcut > b.shortcut ? 1 : 0;

export interface PolarCommands {
    commands: PolarCommandRow[];
    /** Puts a saved command in the list, replacing the one with its id. */
    saved: (row: PolarCommandRow) => void;
    /** Removes one at once, putting it back if the server refuses. */
    remove: (row: PolarCommandRow) => Promise<void>;
}

/** The signed-in person's commands: the cached list now, the server's after. */
export function usePolarCommands(): PolarCommands {
    const t = useTranslations("polar");
    const toast = useToast();
    const [commands, setCommands] = useState<PolarCommandRow[]>([]);
    const set = useCallback((next: PolarCommandRow[]) => {
        setCommands(next);
        writeCache(next);
    }, []);
    useEffect(() => {
        const cached = readCache();
        if (cached) setCommands(cached);
        fetch("/api/polar/commands")
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { commands?: PolarCommandRow[] } | null) => {
                if (Array.isArray(data?.commands)) set(data.commands);
            })
            .catch(() => undefined);
    }, [set]);
    const now = useRef(commands);
    now.current = commands;
    const saved = useCallback(
        (row: PolarCommandRow) =>
            set([...now.current.filter((entry) => entry.id !== row.id), row].sort(byShortcut)),
        [set]
    );
    const remove = useCallback(
        async (row: PolarCommandRow) => {
            const before = now.current;
            set(before.filter((entry) => entry.id !== row.id));
            const response = await fetch(`/api/polar/commands/${row.id}`, {
                method: "DELETE"
            }).catch(() => null);
            // Already gone is what was asked for.
            if (response?.ok || response?.status === 404) return;
            set(before);
            toast.show({ title: t("commands.errors.failed") });
        },
        [set, t, toast]
    );
    return { commands, saved, remove };
}

/** What the form opens with: a command to edit, or a draft for a new one. */
export type CommandDraft = Partial<Pick<PolarCommandRow, "id" | "shortcut" | "prompt">> & {
    choice?: ModelChoice;
};

const SERVER_ERRORS = ["too_many", "unknown_model"] as const;

export function CommandForm({
    draft,
    commands,
    providers,
    onClose,
    onSaved
}: {
    draft: CommandDraft;
    commands: readonly PolarCommandRow[];
    providers: ModelSelectorProvider[];
    onClose: () => void;
    onSaved: (row: PolarCommandRow) => void;
}) {
    const t = useTranslations("polar");
    const editing = commands.find((entry) => entry.id === draft.id) ?? null;
    const [shortcut, setShortcut] = useState(draft.shortcut ?? "");
    const [prompt, setPrompt] = useState(draft.prompt ?? "");
    const [choice, setChoice] = useState<ModelChoice>(
        draft.choice ?? polarShared.automaticChoice()
    );
    const [saving, setSaving] = useState(false);
    const [taken, setTaken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const others = commands
        .filter((entry) => entry.id !== editing?.id)
        .map((entry) => entry.shortcut);
    if (taken) others.push(taken);
    // An empty field is unfinished, not wrong: it is marked required instead.
    const issue: CommandShortcutIssue | null = shortcut.trim()
        ? polarShared.shortcutIssue(shortcut, others)
        : null;
    const parsedPrompt = polarShared.commandPromptSchema.safeParse(prompt);
    const normalized = polarShared.normalizeShortcut(shortcut);
    const unchanged =
        editing !== null &&
        normalized === editing.shortcut &&
        parsedPrompt.success &&
        parsedPrompt.data === editing.prompt &&
        JSON.stringify(choice) === JSON.stringify(editing.choice);
    const ready = !!normalized && !issue && parsedPrompt.success && !unchanged && !saving;

    const submit = async () => {
        if (!ready || !parsedPrompt.success) return;
        setSaving(true);
        setError(null);
        const response = await fetch(
            editing ? `/api/polar/commands/${editing.id}` : "/api/polar/commands",
            {
                method: editing ? "PATCH" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ shortcut: normalized, prompt: parsedPrompt.data, choice })
            }
        ).catch(() => null);
        const body = (await response?.json().catch(() => null)) as {
            command?: PolarCommandRow;
            error?: string;
        } | null;
        setSaving(false);
        if (response?.ok && body?.command) {
            onSaved(body.command);
            onClose();
            return;
        }
        if (body?.error === "taken") return setTaken(normalized);
        const code: (typeof SERVER_ERRORS)[number] | "failed" =
            SERVER_ERRORS.find((known) => known === body?.error) ?? "failed";
        setError(t(`commands.errors.${code}`, { most: polarShared.POLAR_COMMAND_MOST }));
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <form
                    className="flex min-w-0 flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {t(editing ? "commands.editTitle" : "commands.new")}
                        </DialogTitle>
                        <DialogDescription>{t("commands.intro")}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1">
                        <label
                            htmlFor="polar-command-shortcut"
                            className="text-xs text-muted-foreground"
                        >
                            {t("commands.shortcut")} *
                        </label>
                        <div className="flex min-w-0 items-center gap-1">
                            <span aria-hidden className="font-mono text-sm text-muted-foreground">
                                /
                            </span>
                            <Input
                                id="polar-command-shortcut"
                                autoFocus
                                required
                                value={shortcut}
                                maxLength={polarShared.POLAR_COMMAND_SHORTCUT_MAX + 1}
                                autoComplete="off"
                                spellCheck={false}
                                aria-invalid={issue ? true : undefined}
                                aria-describedby="polar-command-shortcut-hint"
                                onChange={(event) => setShortcut(event.target.value)}
                                className="font-mono"
                            />
                        </div>
                        <p
                            id="polar-command-shortcut-hint"
                            className={
                                issue ? "text-xs text-danger-ink" : "text-xs text-muted-foreground"
                            }
                        >
                            {issue
                                ? t(`commands.issues.${issue}`, {
                                      most: polarShared.POLAR_COMMAND_SHORTCUT_MAX
                                  })
                                : t("commands.shortcutHint")}
                        </p>
                    </div>
                    <div className="space-y-1">
                        <label
                            htmlFor="polar-command-prompt"
                            className="text-xs text-muted-foreground"
                        >
                            {t("commands.prompt")} *
                        </label>
                        <Textarea
                            id="polar-command-prompt"
                            required
                            rows={6}
                            value={prompt}
                            maxLength={polarShared.POLAR_COMMAND_PROMPT_MAX}
                            onChange={(event) => setPrompt(event.target.value)}
                        />
                        <p className="text-right text-xs text-foreground-subtle">
                            {prompt.length}/{polarShared.POLAR_COMMAND_PROMPT_MAX}
                        </p>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{t("commands.model")}</span>
                        <ModelSelector providers={providers} choice={choice} onChoice={setChoice} />
                    </div>
                    {error ? (
                        <p role="alert" className="text-xs text-danger-ink">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("commands.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready} disabled={saving}>
                            {t("commands.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Every command this person keeps, with a way to add, edit and delete them. */
export function CommandsDialog({
    store,
    providers,
    onClose,
    onEdit
}: {
    store: PolarCommands;
    providers: ModelSelectorProvider[];
    onClose: () => void;
    onEdit: (draft: CommandDraft) => void;
}) {
    const t = useTranslations("polar");
    const [deleting, setDeleting] = useState<PolarCommandRow | null>(null);
    const full = store.commands.length >= polarShared.POLAR_COMMAND_MOST;
    const modelName = (choice: ModelChoice) =>
        polarShared.isAutomatic(choice)
            ? t("picker.automatic")
            : (providers
                  .flatMap((entry) => entry.models)
                  .find(
                      (model) => model.provider === choice.provider && model.model === choice.model
                  )?.name ?? t("commands.modelGone"));
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="flex max-h-[min(36rem,85dvh)] max-w-lg flex-col gap-3">
                <DialogHeader>
                    <DialogTitle>{t("commands.manage")}</DialogTitle>
                    <DialogDescription>{t("commands.intro")}</DialogDescription>
                </DialogHeader>
                <ul className="-mx-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {store.commands.length === 0 ? (
                        <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                            {t("commands.empty")}
                        </li>
                    ) : null}
                    {store.commands.map((row) => (
                        <li
                            key={row.id}
                            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-card-hover"
                        >
                            <button
                                type="button"
                                className="flex min-w-0 flex-1 flex-col text-left"
                                onClick={() => onEdit(row)}
                            >
                                <span className="truncate font-mono text-sm text-foreground">
                                    /{row.shortcut}
                                </span>
                                <span
                                    className="truncate text-xs text-muted-foreground"
                                    title={row.prompt}
                                >
                                    {polarShared.firstLine(row.prompt)}
                                </span>
                            </button>
                            <span
                                className="hidden max-w-[35%] shrink-0 truncate text-xs text-foreground-subtle sm:inline"
                                title={modelName(row.choice)}
                            >
                                {modelName(row.choice)}
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={t("commands.edit", { shortcut: row.shortcut })}
                                title={t("commands.edit", { shortcut: row.shortcut })}
                                onClick={() => onEdit(row)}
                            >
                                <Pencil className="size-3.5" />
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={t("commands.delete", { shortcut: row.shortcut })}
                                title={t("commands.delete", { shortcut: row.shortcut })}
                                onClick={() => setDeleting(row)}
                            >
                                <Trash2 className="size-3.5" />
                            </Button>
                        </li>
                    ))}
                </ul>
                <DialogFooter className="items-center sm:justify-between">
                    <span className="text-xs text-foreground-subtle">
                        {t("commands.count", {
                            count: store.commands.length,
                            most: polarShared.POLAR_COMMAND_MOST
                        })}
                    </span>
                    <Button
                        type="button"
                        aria-disabled={full}
                        title={
                            full
                                ? t("commands.errors.too_many", {
                                      most: polarShared.POLAR_COMMAND_MOST
                                  })
                                : undefined
                        }
                        onClick={() => (full ? undefined : onEdit({}))}
                    >
                        <Plus className="size-4" />
                        {t("commands.new")}
                    </Button>
                </DialogFooter>
                {deleting ? (
                    <ConfirmDeleteDialog
                        open
                        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                        name={`/${deleting.shortcut}`}
                        requireTyping={false}
                        kind={t("commands.kind")}
                        title={t("commands.deleteTitle")}
                        question={t("commands.deleteQuestion", { shortcut: deleting.shortcut })}
                        confirmLabel={t("commands.deleteConfirm")}
                        onConfirm={() => {
                            void store.remove(deleting);
                            setDeleting(null);
                        }}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

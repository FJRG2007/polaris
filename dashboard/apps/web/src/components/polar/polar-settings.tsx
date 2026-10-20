"use client";

/**
 * Polar's settings, opened from the gear in Polar's header: what it remembers
 * about the person (with the switch that turns memory off), and everything
 * else that is theirs to manage. Every change shows at once and is put back if
 * the server refuses it.
 */

import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton,
    Switch,
    useToast
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    looksSecret,
    normalizeMemoryText,
    POLAR_MEMORY_MAX_CHARS
} from "@/lib/polar/shared";

export interface MemoryRow {
    id: string;
    text: string;
}

/** Why a memory cannot be saved as typed, or null when it can. Empty is
 *  incomplete rather than wrong, so it has no message of its own. */
export function memoryProblem(text: string): "too_long" | "secret" | null {
    const value = normalizeMemoryText(text);
    if (value.length > POLAR_MEMORY_MAX_CHARS) return "too_long";
    if (value && looksSecret(value)) return "secret";
    return null;
}

const CACHE_KEY = "polar.memories";

function readCache(): { enabled: boolean; memories: MemoryRow[] } | null {
    try {
        const raw = window.sessionStorage.getItem(CACHE_KEY);
        return raw ? (JSON.parse(raw) as { enabled: boolean; memories: MemoryRow[] }) : null;
    } catch {
        return null;
    }
}

function writeCache(value: { enabled: boolean; memories: MemoryRow[] }): void {
    try {
        window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(value));
    } catch {
        // Not cached; the next open asks again.
    }
}

async function send(url: string, method: string, body?: unknown): Promise<Response | null> {
    return fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).catch(() => null);
}

type MemoryError = "secret" | "too_long" | "full" | "rate_limited" | "failed";

/** The refusal code a memory route answered with, as one the screen has words for. */
function refusalOf(code: unknown): MemoryError {
    return code === "secret" || code === "too_long" || code === "full" || code === "rate_limited"
        ? code
        : "failed";
}

function Section({
    title,
    description,
    action,
    children
}: {
    title: string;
    description?: string;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="flex flex-col gap-2">
            <div className="flex min-w-0 items-start gap-3">
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-foreground">{title}</h3>
                    {description ? (
                        <p className="text-xs text-muted-foreground">{description}</p>
                    ) : null}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

function MemoryEditor({
    initial,
    label,
    onSave,
    onCancel
}: {
    initial: string;
    label: string;
    onSave: (text: string) => void;
    onCancel: () => void;
}) {
    const t = useTranslations("polar");
    const [draft, setDraft] = useState(initial);
    const problem = memoryProblem(draft);
    const value = normalizeMemoryText(draft);
    const ready = value !== "" && !problem && value !== normalizeMemoryText(initial);
    return (
        <div className="flex flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1">
                <Input
                    autoFocus
                    aria-label={label}
                    aria-invalid={problem ? true : undefined}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && ready) onSave(value);
                        if (event.key === "Escape") {
                            event.stopPropagation();
                            onCancel();
                        }
                    }}
                    placeholder={t("settings.memory.placeholder")}
                    className="h-8 min-w-0 flex-1"
                />
                <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("settings.memory.save")}
                    title={t("settings.memory.save")}
                    aria-disabled={!ready}
                    onClick={() => ready && onSave(value)}
                >
                    <Check />
                </Button>
                <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("settings.memory.cancel")}
                    title={t("settings.memory.cancel")}
                    onClick={onCancel}
                >
                    <X />
                </Button>
            </div>
            {problem ? (
                <p role="alert" className="text-xs text-danger-ink">
                    {t(`settings.memory.errors.${problem}`, { most: POLAR_MEMORY_MAX_CHARS })}
                </p>
            ) : null}
        </div>
    );
}

/** The memory list with its switch, add, edit, delete and clear. */
export function MemorySettings() {
    const t = useTranslations("polar");
    const toast = useToast();
    const [state, setState] = useState<{ enabled: boolean; memories: MemoryRow[] } | null>(null);
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);
    const [clearing, setClearing] = useState(false);
    const now = useRef(state);
    now.current = state;

    const commit = (next: { enabled: boolean; memories: MemoryRow[] }) => {
        setState(next);
        writeCache(next);
    };

    useEffect(() => {
        const cached = readCache();
        if (cached) setState(cached);
        void fetch("/api/polar/memories")
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { enabled: boolean; memories: MemoryRow[] } | null) => {
                if (!data) return;
                commit({
                    enabled: data.enabled,
                    memories: data.memories.map(({ id, text }) => ({ id, text }))
                });
            })
            .catch(() => undefined);
    }, []);

    /** Applies a change now and puts it back when the server says no. */
    const optimistic = async (
        next: { enabled: boolean; memories: MemoryRow[] },
        request: () => Promise<Response | null>,
        settle?: (data: unknown) => void
    ) => {
        const before = now.current;
        commit(next);
        const response = await request();
        if (response?.ok) {
            settle?.(await response.json().catch(() => null));
            return;
        }
        if (before) commit(before);
        const error = ((await response?.json().catch(() => null)) as { error?: unknown } | null)
            ?.error;
        toast.show({ title: t(`settings.memory.errors.${refusalOf(error)}`, { most: POLAR_MEMORY_MAX_CHARS }) });
    };

    const replaceRow = (temp: string) => (data: unknown) => {
        const memory = (data as { memory?: MemoryRow } | null)?.memory;
        const current = now.current;
        if (!memory || !current) return;
        commit({
            ...current,
            memories: [
                { id: memory.id, text: memory.text },
                ...current.memories.filter((row) => row.id !== temp && row.id !== memory.id)
            ]
        });
    };

    if (!state) {
        return (
            <Section title={t("settings.memory.title")} description={t("settings.memory.intro")}>
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
            </Section>
        );
    }

    return (
        <Section
            title={t("settings.memory.title")}
            description={t("settings.memory.intro")}
            action={
                <Switch
                    checked={state.enabled}
                    aria-label={t("settings.memory.toggle")}
                    onChange={(enabled) =>
                        void optimistic({ ...state, enabled }, () =>
                            send("/api/polar/preferences", "PATCH", { memory: enabled })
                        )
                    }
                />
            }
        >
            {!state.enabled ? (
                <p className="text-xs text-muted-foreground">{t("settings.memory.off")}</p>
            ) : null}
            {adding ? (
                <MemoryEditor
                    initial=""
                    label={t("settings.memory.add")}
                    onCancel={() => setAdding(false)}
                    onSave={(text) => {
                        setAdding(false);
                        const temp = `pending-${Date.now()}`;
                        void optimistic(
                            { ...state, memories: [{ id: temp, text }, ...state.memories] },
                            () => send("/api/polar/memories", "POST", { text }),
                            replaceRow(temp)
                        );
                    }}
                />
            ) : null}
            {state.memories.length === 0 && !adding ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("settings.memory.empty")}
                </p>
            ) : (
                <ul className="flex max-h-72 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {state.memories.map((row) => (
                        <li key={row.id} className="flex min-w-0 items-center gap-1 px-2 py-1.5">
                            {editing === row.id ? (
                                <div className="min-w-0 flex-1">
                                    <MemoryEditor
                                        initial={row.text}
                                        label={t("settings.memory.edit")}
                                        onCancel={() => setEditing(null)}
                                        onSave={(text) => {
                                            setEditing(null);
                                            void optimistic(
                                                {
                                                    ...state,
                                                    memories: state.memories.map((entry) =>
                                                        entry.id === row.id ? { ...entry, text } : entry
                                                    )
                                                },
                                                () =>
                                                    send(`/api/polar/memories/${row.id}`, "PATCH", {
                                                        text
                                                    })
                                            );
                                        }}
                                    />
                                </div>
                            ) : (
                                <>
                                    <span className="min-w-0 flex-1 break-words text-sm text-foreground">
                                        {row.text}
                                    </span>
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        aria-label={t("settings.memory.edit")}
                                        title={t("settings.memory.edit")}
                                        disabled={row.id.startsWith("pending-")}
                                        onClick={() => setEditing(row.id)}
                                    >
                                        <Pencil />
                                    </Button>
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        aria-label={t("settings.memory.delete")}
                                        title={t("settings.memory.delete")}
                                        disabled={row.id.startsWith("pending-")}
                                        onClick={() =>
                                            void optimistic(
                                                {
                                                    ...state,
                                                    memories: state.memories.filter(
                                                        (entry) => entry.id !== row.id
                                                    )
                                                },
                                                () => send(`/api/polar/memories/${row.id}`, "DELETE")
                                            )
                                        }
                                    >
                                        <Trash2 />
                                    </Button>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={adding}>
                    <Plus />
                    {t("settings.memory.add")}
                </Button>
                {state.memories.length > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => setClearing(true)}>
                        <Trash2 />
                        {t("settings.memory.clear")}
                    </Button>
                ) : null}
            </div>
            {clearing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => (open ? undefined : setClearing(false))}
                    name={t("settings.memory.title")}
                    requireTyping={false}
                    kind={t("settings.memory.kind")}
                    title={t("settings.memory.clearTitle")}
                    question={t("settings.memory.clearQuestion")}
                    confirmLabel={t("settings.memory.clear")}
                    onConfirm={() => {
                        setClearing(false);
                        void optimistic({ ...state, memories: [] }, () =>
                            send("/api/polar/memories", "DELETE")
                        );
                    }}
                />
            ) : null}
        </Section>
    );
}

/** The settings dialog. `sections` past memory are added by their features. */
export function PolarSettings({
    open,
    onOpenChange,
    children
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children?: ReactNode;
}) {
    const t = useTranslations("polar");
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t("settings.title")}</DialogTitle>
                    <DialogDescription>{t("settings.intro")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-h-0 flex-col gap-6 overflow-y-auto pr-1">
                    {open ? <MemorySettings /> : null}
                    {children}
                </div>
            </DialogContent>
        </Dialog>
    );
}

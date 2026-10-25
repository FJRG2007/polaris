"use client";

/**
 * The Ranks tab: the symbol, tag and colour players carry in chat and in the tab
 * list, who has which, and the teams the server already had.
 *
 * Edited as a draft and saved as one: the order is what the tab list sorts by,
 * so moving a rank and renaming another are one change the server gets once.
 * The draft is checked against the same schema the server checks, as it is
 * typed. Nothing on the server changes until Save, and a save that would remove
 * a team Polaris did not create says which first.
 */

import * as ui from "@polaris/ui";
import { useGameText, useSchemaText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { McLine } from "../../components/mc-text";
import * as ranks from "../../lib/minecraft/ranks";
import type { Rank, RankColor } from "../../lib/minecraft/ranks";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { MOTD_COLORS, type MotdSpan } from "../../lib/minecraft/motd";
import {
    ArrowDown,
    ArrowUp,
    Crown,
    Download,
    Loader2,
    Pencil,
    Plus,
    Trash2,
    X
} from "lucide-react";
import {
    importRanksAction,
    readRanksAction,
    saveRanksAction,
    type RanksView
} from "./ranks-actions";

const { useConfirm } = hostUi.confirmDialog;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;

const KEPT_STATE_MS = 30_000;
const COLOR_NAMES = Object.keys(ranks.RANK_COLORS) as RankColor[];

function hexOf(color: RankColor | null): string {
    return color ? (MOTD_COLORS[ranks.RANK_COLORS[color]]?.hex ?? "#FFFFFF") : "#FFFFFF";
}

function span(text: string, color: RankColor | null, bold = false): MotdSpan {
    return {
        text,
        color: hexOf(color),
        bold,
        italic: false,
        underline: false,
        strikethrough: false,
        obfuscated: false
    };
}

/** The name as the game draws it with this rank: prefix, then the name in the
 *  team's colour. */
function rankedName(rank: Rank, player: string): MotdSpan[] {
    return [
        ...ranks.prefixRuns(rank).map((run) => span(run.text, run.color, run.bold)),
        span(player, rank.color)
    ];
}

function RankPreview({ rank, player, message }: { rank: Rank; player: string; message: string }) {
    const t = useGameText("minecraft");
    return (
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <div className="min-w-0">
                <p className="mb-1 text-xs text-muted-foreground">{t("ranks.previewChat")}</p>
                <div className="truncate rounded-md bg-[#101010]/90 px-3 py-2 font-mono text-sm">
                    <McLine
                        spans={[
                            span("<", "white"),
                            ...rankedName(rank, player),
                            span(`> ${message}`, "white")
                        ]}
                    />
                </div>
            </div>
            <div className="min-w-0">
                <p className="mb-1 text-xs text-muted-foreground">{t("ranks.previewTab")}</p>
                <div className="truncate rounded-md bg-[#2a2a2a] px-3 py-2 font-mono text-sm">
                    <McLine spans={rankedName(rank, player)} />
                </div>
            </div>
        </div>
    );
}

/** The issues of one rank in the draft, by field. */
function issuesOf(
    result: ReturnType<typeof ranks.ranksSchema.safeParse> | null,
    index: number
): Record<string, string> {
    const found: Record<string, string> = {};
    if (!result || result.success) return found;
    for (const issue of result.error.issues) {
        if (issue.path[0] !== index) continue;
        const field = String(issue.path[1] ?? "rank");
        found[field] ??= issue.message;
    }
    return found;
}

export function MinecraftRanks({ installedAppId }: { installedAppId: string }) {
    const t = useGameText("minecraft");
    const colorWords = useGameText("games");
    const stateKey = `ranks:${installedAppId}`;
    const [view, setView] = useState<RanksView | null>(null);
    useKeptSnapshot<RanksView>(stateKey, KEPT_STATE_MS, (kept) =>
        setView((current) => current ?? kept.value)
    );
    const [draft, setDraft] = useState<Rank[] | null>(null);
    const [editing, setEditing] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [readError, setReadError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [found, setFound] = useState<Rank[] | null>(null);
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
    const [importing, setImporting] = useState(false);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    const text = useMessageText();
    // What the draft started from, so a fresher read replaces an untouched draft.
    const shown = useRef<readonly Rank[] | null>(null);
    shown.current = view?.ranks ?? null;

    function load(): void {
        setReadError(null);
        void readRanksAction(installedAppId).then((answer) => {
            if (answer.view) {
                const next = answer.view;
                const before = shown.current;
                setView(next);
                writeSnapshot(stateKey, next);
                setDraft((current) =>
                    current === null || (before !== null && !ui.isDirty([...before], current))
                        ? [...next.ranks]
                        : current
                );
            } else setReadError(answer.error ?? t("ranks.readFailed"));
        });
    }
    useEffect(load, [installedAppId]);
    useEffect(() => {
        if (view && draft === null) setDraft([...view.ranks]);
    }, [view, draft]);

    const result = useMemo(() => (draft ? ranks.ranksSchema.safeParse(draft) : null), [draft]);
    const saved = view?.ranks ?? null;
    const savedIds = useMemo(() => new Set((saved ?? []).map((rank) => rank.id)), [saved]);
    const dirty = draft !== null && saved !== null && ui.isDirty([...saved], draft);
    const valid = result?.success === true;

    const update = (index: number, patch: Partial<Rank>) => {
        setNote(null);
        setError(null);
        setDraft((current) => {
            if (!current) return current;
            const next = [...current];
            next[index] = { ...next[index]!, ...patch };
            return next;
        });
    };

    const add = () => {
        if (!draft) return;
        const id = ranks.rankId(
            "rank",
            draft.map((rank) => rank.id)
        );
        setDraft([
            ...draft,
            { id, name: "", tag: "", symbol: "", color: "white", bold: false, players: [] }
        ]);
        setEditing(id);
        setNote(null);
    };

    const remove = async (index: number) => {
        const rank = draft?.[index];
        if (!rank) return;
        const sure = await confirm({
            title: t("ranks.deleteTitle", { name: rank.name || rank.tag || rank.id }),
            description: t("ranks.deleteBody"),
            confirmLabel: t("ranks.confirmDelete"),
            cancelLabel: t("ranks.cancel"),
            danger: true
        });
        if (!sure) return;
        setDraft((current) => (current ? current.filter((_, at) => at !== index) : current));
        setNote(null);
    };

    const runImport = () => {
        setImporting(true);
        setError(null);
        void importRanksAction(installedAppId).then((answer) => {
            setImporting(false);
            if (!answer.ranks) {
                setError(answer.error ?? t("ranks.importFailed"));
                return;
            }
            const taken = (draft ?? []).map((rank) => rank.id);
            const fresh = answer.ranks
                .filter((rank) => !(draft ?? []).some((one) => one.source === rank.source))
                .map((rank) => {
                    const id = ranks.rankId(rank.id, taken);
                    taken.push(id);
                    return { ...rank, id };
                });
            setFound(fresh);
            setPicked(new Set(fresh.map((rank) => rank.id)));
        });
    };

    const addFound = () => {
        if (!found || !draft) return;
        setDraft([...draft, ...found.filter((rank) => picked.has(rank.id))]);
        setFound(null);
        setNote(null);
    };

    const save = async () => {
        if (!draft || !result?.success || !view) return;
        const wanted = named(result.data, savedIds);
        const replaced = ranks.replacedTeams(wanted);
        if (replaced.length > 0) {
            const sure = await confirm({
                title: t("ranks.replaceTitle"),
                description: `${t("ranks.replaceBody")} ${replaced.join(", ")}`,
                confirmLabel: t("ranks.replaceConfirm"),
                cancelLabel: t("ranks.cancel")
            });
            if (!sure) return;
        }
        const before = view;
        setError(null);
        setNote(null);
        // Shown as saved at once; put back if the save is refused.
        setView({ ...view, ranks: wanted });
        startTransition(async () => {
            const answer = await saveRanksAction({ installedAppId, ranks: wanted });
            if (!answer.saved) {
                setView(before);
                setError(answer.error ?? t("ranks.saveFailed"));
                return;
            }
            const next = { ...before, ranks: answer.saved.ranks };
            setView(next);
            writeSnapshot(stateKey, next);
            setDraft([...answer.saved.ranks]);
            setEditing(null);
            setNote(
                !answer.saved.applied
                    ? t("ranks.savedOffline")
                    : answer.saved.refused > 0
                      ? t("ranks.partial", { count: answer.saved.refused })
                      : t("ranks.saved")
            );
        });
    };

    const bedrock = view?.edition === "bedrock";
    const players = view?.players ?? [];

    return (
        <div className="flex flex-col gap-4">
            {confirmElement}
            <ui.Card>
                <ui.CardBody className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <h2 className="text-base font-semibold">{t("ranks.title")}</h2>
                        <p className="text-sm text-muted-foreground">{t("ranks.intro")}</p>
                        {!bedrock && (
                            <p className="mt-1 text-xs text-muted-foreground">
                                {t("ranks.reapplied")}
                            </p>
                        )}
                    </div>
                    {!bedrock && (
                        <div className="flex shrink-0 flex-wrap gap-2">
                            <ui.Button
                                variant="secondary"
                                onClick={runImport}
                                disabled={importing || !view || pending}
                            >
                                {importing ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <Download className="size-4" />
                                )}
                                {importing ? t("ranks.importing") : t("ranks.import")}
                            </ui.Button>
                            <ui.Button
                                onClick={add}
                                disabled={!draft || pending || draft.length >= ranks.MAX_RANKS}
                            >
                                <Plus className="size-4" />
                                {t("ranks.add")}
                            </ui.Button>
                        </div>
                    )}
                </ui.CardBody>
            </ui.Card>

            {bedrock && (
                <ui.Card>
                    <ui.CardBody className="text-sm text-muted-foreground">
                        {t("ranks.bedrock")}
                    </ui.CardBody>
                </ui.Card>
            )}

            {readError && (
                <ui.Card>
                    <ui.CardBody className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="text-danger">{readError}</span>
                        <ui.Button variant="secondary" onClick={load}>
                            {t("ranks.retry")}
                        </ui.Button>
                    </ui.CardBody>
                </ui.Card>
            )}

            {!view && !readError && (
                <div className="flex flex-col gap-2" aria-busy="true">
                    <ui.Skeleton className="h-16 w-full" />
                    <ui.Skeleton className="h-16 w-full" />
                </div>
            )}

            {!bedrock && draft && draft.length === 0 && (
                <ui.EmptyState
                    icon={<Crown className="size-5" />}
                    title={t("ranks.empty")}
                    description={t("ranks.emptyHint")}
                />
            )}

            {!bedrock && draft && draft.length > 0 && (
                <ul className="flex flex-col gap-2">
                    {draft.map((rank, index) => {
                        const issues = issuesOf(result, index);
                        const label = rank.name || rank.tag || rank.id;
                        const open = editing === rank.id;
                        return (
                            <li key={rank.id}>
                                <ui.Card>
                                    <ui.CardBody className="flex flex-col gap-3">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate rounded-md bg-[#2a2a2a] px-3 py-1.5 font-mono text-sm">
                                                    <McLine
                                                        spans={rankedName(
                                                            { ...rank, tag: rank.tag || "?" },
                                                            rank.name || t("ranks.previewPlayer")
                                                        )}
                                                    />
                                                </div>
                                                <p className="mt-1 truncate text-xs text-muted-foreground">
                                                    {t("ranks.playerCount", {
                                                        count: rank.players.length
                                                    })}
                                                    {rank.source
                                                        ? ` - ${t("ranks.importedFrom", { team: rank.source })}`
                                                        : ""}
                                                    {Object.keys(issues).length > 0 && !open ? (
                                                        <span className="text-danger">
                                                            {" "}
                                                            - {text(Object.values(issues)[0])}
                                                        </span>
                                                    ) : null}
                                                </p>
                                            </div>
                                            <IconButton
                                                label={t("ranks.moveUp", { name: label })}
                                                disabled={index === 0 || pending}
                                                onClick={() =>
                                                    setDraft(ui.moved(draft, index, index - 1))
                                                }
                                            >
                                                <ArrowUp className="size-4" />
                                            </IconButton>
                                            <IconButton
                                                label={t("ranks.moveDown", { name: label })}
                                                disabled={index === draft.length - 1 || pending}
                                                onClick={() =>
                                                    setDraft(ui.moved(draft, index, index + 1))
                                                }
                                            >
                                                <ArrowDown className="size-4" />
                                            </IconButton>
                                            <IconButton
                                                label={t("ranks.edit", { name: label })}
                                                disabled={pending}
                                                onClick={() => setEditing(open ? null : rank.id)}
                                            >
                                                <Pencil className="size-4" />
                                            </IconButton>
                                            <IconButton
                                                label={t("ranks.delete", { name: label })}
                                                disabled={pending}
                                                onClick={() => void remove(index)}
                                            >
                                                <Trash2 className="size-4" />
                                            </IconButton>
                                        </div>
                                        {open && (
                                            <RankEditor
                                                rank={rank}
                                                issues={issues}
                                                text={text}
                                                colorName={(color) =>
                                                    colorWords(
                                                        `motd.colors.${ranks.RANK_COLORS[color]}` as never
                                                    )
                                                }
                                                players={players}
                                                taken={
                                                    new Set(
                                                        draft
                                                            .filter((_, at) => at !== index)
                                                            .flatMap((one) =>
                                                                one.players.map((player) =>
                                                                    player.toLowerCase()
                                                                )
                                                            )
                                                    )
                                                }
                                                onChange={(patch) => update(index, patch)}
                                                onDone={() => setEditing(null)}
                                            />
                                        )}
                                    </ui.CardBody>
                                </ui.Card>
                            </li>
                        );
                    })}
                </ul>
            )}

            {(error || note) && (
                <p
                    className={error ? "text-sm text-danger" : "text-sm text-muted-foreground"}
                    role="status"
                >
                    {error ?? note}
                </p>
            )}

            {!bedrock && draft && (dirty || pending) && (
                <div className="sticky bottom-2 z-10 flex flex-wrap items-center justify-end gap-2 rounded-lg border bg-background/95 p-2 shadow-sm">
                    <span className="mr-auto min-w-0 text-sm text-muted-foreground">
                        {valid || pending ? t("ranks.unsaved") : t("ranks.invalid")}
                    </span>
                    <ui.Button
                        variant="ghost"
                        disabled={pending}
                        onClick={() => {
                            setDraft(saved ? [...saved] : []);
                            setEditing(null);
                            setError(null);
                        }}
                    >
                        {t("ranks.discard")}
                    </ui.Button>
                    <ui.Button onClick={() => void save()} disabled={!valid || pending}>
                        {pending && <Loader2 className="size-4 animate-spin" />}
                        {pending ? t("ranks.saving") : t("ranks.save")}
                    </ui.Button>
                </div>
            )}

            {found && (
                <ui.Dialog open onOpenChange={(open) => !open && setFound(null)}>
                    <ui.DialogContent className="max-w-lg">
                        <ui.DialogHeader>
                            <ui.DialogTitle>{t("ranks.importTitle")}</ui.DialogTitle>
                            <ui.DialogDescription>
                                {found.length === 0 ? t("ranks.importNone") : t("ranks.importBody")}
                            </ui.DialogDescription>
                        </ui.DialogHeader>
                        {found.length > 0 && (
                            <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
                                {found.map((rank) => (
                                    <li key={rank.id}>
                                        <label className="flex min-w-0 items-center gap-3 text-sm">
                                            <ui.Checkbox
                                                checked={picked.has(rank.id)}
                                                onChange={(event) => {
                                                    const checked = event.target.checked;
                                                    setPicked((current) => {
                                                        const next = new Set(current);
                                                        if (checked) next.add(rank.id);
                                                        else next.delete(rank.id);
                                                        return next;
                                                    });
                                                }}
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate rounded-md bg-[#2a2a2a] px-2 py-1 font-mono">
                                                    <McLine
                                                        spans={rankedName(
                                                            rank,
                                                            t("ranks.previewPlayer")
                                                        )}
                                                    />
                                                </span>
                                                <span className="block truncate text-xs text-muted-foreground">
                                                    {t("ranks.importedFrom", {
                                                        team: rank.source ?? ""
                                                    })}{" "}
                                                    -{" "}
                                                    {t("ranks.playerCount", {
                                                        count: rank.players.length
                                                    })}
                                                </span>
                                            </span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <ui.DialogFooter>
                            <ui.Button variant="ghost" onClick={() => setFound(null)}>
                                {found.length === 0 ? t("ranks.done") : t("ranks.cancel")}
                            </ui.Button>
                            {found.length > 0 && (
                                <ui.Button onClick={addFound} disabled={picked.size === 0}>
                                    {t("ranks.importAdd", { count: picked.size })}
                                </ui.Button>
                            )}
                        </ui.DialogFooter>
                    </ui.DialogContent>
                </ui.Dialog>
            )}
        </div>
    );
}

/**
 * The draft with every rank not saved yet named after what it is called. Done
 * at save rather than as it is typed: the id keys the row, and a key that
 * changed with each letter would rebuild the editor under the cursor. A saved
 * rank keeps its id, so its players never change team for a rename.
 */
export function named(draft: readonly Rank[], savedIds: ReadonlySet<string>): Rank[] {
    const taken = draft.filter((rank) => savedIds.has(rank.id)).map((rank) => rank.id);
    return draft.map((rank) => {
        if (savedIds.has(rank.id)) return rank;
        const id = ranks.rankId(rank.name, taken);
        taken.push(id);
        return { ...rank, id };
    });
}

/** A schema message in the reader's language. */
function useMessageText(): (message: string | undefined) => string {
    const schemaText = useSchemaText();
    return (message) => (message ? (schemaText(message) ?? message) : "");
}

function IconButton({
    label,
    disabled,
    onClick,
    size = "icon",
    children
}: {
    size?: "icon" | "icon-xs";
    label: string;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <ui.Button
            size={size}
            variant="ghost"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className="shrink-0"
        >
            {children}
        </ui.Button>
    );
}

function RankEditor({
    rank,
    issues,
    text,
    colorName,
    players,
    taken,
    onChange,
    onDone
}: {
    rank: Rank;
    issues: Record<string, string>;
    text: (message: string | undefined) => string;
    colorName: (color: RankColor) => string;
    players: RanksView["players"];
    taken: ReadonlySet<string>;
    onChange: (patch: Partial<Rank>) => void;
    onDone: () => void;
}) {
    const t = useGameText("minecraft");
    const [typed, setTyped] = useState("");
    const name = ranks.cleanText(typed);
    const has = new Set(rank.players.map((player) => player.toLowerCase()));
    const typedProblem =
        name.length === 0
            ? null
            : !ranks.PLAYER_NAME.test(name)
              ? t("ranks.errors.badPlayer")
              : taken.has(name.toLowerCase())
                ? t("ranks.errors.taken", { player: name })
                : null;
    const addPlayer = (player: string) => {
        if (has.has(player.toLowerCase())) return;
        onChange({ players: [...rank.players, player] });
    };
    const suggestions = [...players]
        .sort((left, right) => Number(right.online) - Number(left.online))
        .filter(
            (one) =>
                !has.has(one.name.toLowerCase()) &&
                !taken.has(one.name.toLowerCase()) &&
                ranks.PLAYER_NAME.test(one.name)
        )
        .slice(0, 30);
    const playerIssue = Object.entries(issues).find(([field]) => field === "players")?.[1];

    return (
        <div className="flex flex-col gap-4 border-t pt-3">
            <div className="grid gap-3 sm:grid-cols-2">
                <Field
                    label={t("ranks.name")}
                    error={rank.name.trim() ? text(issues.name) : undefined}
                    required
                >
                    <ui.Input
                        value={rank.name}
                        maxLength={ranks.NAME_MAX}
                        onChange={(event) => onChange({ name: event.target.value })}
                        aria-invalid={Boolean(rank.name.trim() && issues.name)}
                    />
                </Field>
                <Field
                    label={t("ranks.tag")}
                    error={rank.tag.trim() ? text(issues.tag) : undefined}
                    required
                >
                    <ui.Input
                        value={rank.tag}
                        maxLength={ranks.TAG_MAX}
                        placeholder={t("ranks.tagPlaceholder")}
                        onChange={(event) => onChange({ tag: event.target.value })}
                        aria-invalid={Boolean(rank.tag.trim() && issues.tag)}
                    />
                </Field>
            </div>
            <Field label={t("ranks.symbol")} error={text(issues.symbol)}>
                <div className="flex flex-wrap gap-1">
                    <ui.Button
                        type="button"
                        size="sm"
                        variant={rank.symbol === "" ? "secondary" : "ghost"}
                        aria-pressed={rank.symbol === ""}
                        onClick={() => onChange({ symbol: "" })}
                    >
                        {t("ranks.noSymbol")}
                    </ui.Button>
                    {ranks.RANK_SYMBOLS.map((symbol) => (
                        <ui.Button
                            key={symbol}
                            type="button"
                            size="sm"
                            variant={rank.symbol === symbol ? "secondary" : "ghost"}
                            aria-pressed={rank.symbol === symbol}
                            aria-label={symbol}
                            onClick={() => onChange({ symbol })}
                            className="w-9 font-mono"
                        >
                            {symbol}
                        </ui.Button>
                    ))}
                    <ui.Input
                        value={rank.symbol}
                        maxLength={4}
                        className="w-16"
                        aria-label={t("ranks.symbol")}
                        onChange={(event) => onChange({ symbol: event.target.value })}
                    />
                </div>
            </Field>
            <Field label={t("ranks.color")}>
                <div
                    className="flex flex-wrap gap-1.5"
                    role="radiogroup"
                    aria-label={t("ranks.color")}
                >
                    {COLOR_NAMES.map((color) => (
                        <button
                            key={color}
                            type="button"
                            role="radio"
                            aria-checked={rank.color === color}
                            aria-label={colorName(color)}
                            title={colorName(color)}
                            onClick={() => onChange({ color })}
                            className={ui.cn(
                                "size-7 rounded-md border outline-offset-2",
                                rank.color === color &&
                                    "ring-2 ring-primary ring-offset-2 ring-offset-background"
                            )}
                            style={{ backgroundColor: hexOf(color) }}
                        />
                    ))}
                </div>
            </Field>
            <label className="flex items-center gap-2 text-sm">
                <ui.Switch
                    checked={rank.bold}
                    onChange={(bold) => onChange({ bold })}
                    aria-label={t("ranks.bold")}
                />
                {t("ranks.bold")}
            </label>
            <RankPreview
                rank={{ ...rank, tag: rank.tag || "?" }}
                player={t("ranks.previewPlayer")}
                message={t("ranks.previewMessage")}
            />
            <Field label={t("ranks.players")} error={text(playerIssue)}>
                {rank.players.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("ranks.noPlayers")}</p>
                ) : (
                    <ul className="flex flex-wrap gap-1.5">
                        {rank.players.map((player) => (
                            <li
                                key={player}
                                className="flex min-w-0 items-center gap-1 rounded-md bg-muted py-0.5 pl-2 pr-0.5 text-sm"
                            >
                                <span className="truncate font-mono" title={player}>
                                    {player}
                                </span>
                                <IconButton
                                    size="icon-xs"
                                    label={t("ranks.removePlayer", { player })}
                                    onClick={() =>
                                        onChange({
                                            players: rank.players.filter((one) => one !== player)
                                        })
                                    }
                                >
                                    <X className="size-3.5" />
                                </IconButton>
                            </li>
                        ))}
                    </ul>
                )}
                <form
                    className="mt-2 flex gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (name && !typedProblem) {
                            addPlayer(name);
                            setTyped("");
                        }
                    }}
                >
                    <ui.Input
                        value={typed}
                        maxLength={17}
                        placeholder={t("ranks.playerPlaceholder")}
                        aria-label={t("ranks.playerPlaceholder")}
                        aria-invalid={Boolean(typedProblem)}
                        onChange={(event) => setTyped(event.target.value)}
                        className="min-w-0 flex-1"
                    />
                    <ui.Button
                        type="submit"
                        variant="secondary"
                        disabled={
                            !name ||
                            Boolean(typedProblem) ||
                            rank.players.length >= ranks.MAX_RANK_PLAYERS
                        }
                    >
                        {t("ranks.addPlayer")}
                    </ui.Button>
                </form>
                {typedProblem && <p className="mt-1 text-xs text-danger">{typedProblem}</p>}
                {suggestions.length > 0 && (
                    <div className="mt-2">
                        <p className="mb-1 text-xs text-muted-foreground">
                            {t("ranks.suggestions")}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                            {suggestions.map((one) => (
                                <ui.Button
                                    key={one.name}
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => addPlayer(one.name)}
                                    className="max-w-full"
                                >
                                    <Plus className="size-3.5" />
                                    <span className="truncate font-mono" title={one.name}>
                                        {one.name}
                                    </span>
                                    {one.online && (
                                        <ui.Badge variant="success">{t("ranks.online")}</ui.Badge>
                                    )}
                                </ui.Button>
                            ))}
                        </div>
                    </div>
                )}
            </Field>
            <div className="flex justify-end">
                <ui.Button variant="secondary" onClick={onDone}>
                    {t("ranks.done")}
                </ui.Button>
            </div>
        </div>
    );
}

function Field({
    label,
    error,
    required,
    children
}: {
    label: string;
    error?: string;
    required?: boolean;
    children: ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1.5 text-sm">
            <span className="text-xs text-muted-foreground">
                {label}
                {required && <span aria-hidden="true"> *</span>}
            </span>
            {children}
            {error && <span className="text-xs text-danger">{error}</span>}
        </div>
    );
}

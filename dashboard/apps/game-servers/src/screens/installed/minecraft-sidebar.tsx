"use client";

/**
 * The side panel: the box on the right of every player's screen, written by
 * Polaris and kept current - who is online, who is in the call of the linked chat,
 * anything the server's own variables can say.
 *
 * Checked as it is typed with the rules the save uses (`sidebar.ts`), and
 * previewed with sample values - moving, where a line takes turns or has an
 * effect, drawn by the same function the server draws it with. Only the
 * server's variables are offered: the panel is the same for everybody, so
 * nothing of one player's can go on it.
 */

import * as mc from "../../lib/minecraft/motd";
import { hostUi } from "@polaris/app-host/client";
import { McLine } from "../../components/mc-text";
import { insertsFor } from "./minecraft-announce";
import { SidebarLineEditor } from "./sidebar-line-editor";
import { previewText } from "../../lib/minecraft/text-vars";
import { renderSidebar } from "../../lib/minecraft/sidebar-render";
import { moved, useListOrder } from "../../components/use-list-order";
import { WholeNumberInput } from "../../components/whole-number-input";
import { GripVertical, Loader2, Plus, Trash2, Trophy } from "lucide-react";
import {
    SIDEBAR_BLOCKS,
    rotatingBlocksAt,
    withBlock,
    withRotatingBlocks,
    withRotatingBlocksAt,
    type SidebarBlock
} from "../../lib/minecraft/sidebar-blocks";
import { EVENTS_RANKING, RANKINGS, STATS_RANKINGS } from "../../lib/minecraft/rankings";
import {
    Button,
    Card,
    CardBody,
    Checkbox,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Skeleton,
    Switch,
    allChosen,
    cn,
    useRangeSelection
} from "@polaris/ui";
import * as side from "../../lib/minecraft/sidebar";
import { VariablesHelp } from "../../components/variables-help";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import {
    readLiveDisplayAction,
    saveLiveDisplayAction,
    type LiveDisplayState
} from "./live-display-actions";

const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;
const { mergeUnchanged } = hostUi.structuralMerge;

/** How old the kept panel may be and still paint first on a revisit. */
const KEPT_DISPLAY_MS = 24 * 3_600_000;

/** The card's name and what it is for, with the switch beside them. */
function SidebarHeading({ control }: { control: ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div>
                <p className="text-sm font-medium">Side panel</p>
                <p className="text-xs text-muted-foreground">
                    A box on the right of every player&apos;s screen. Polaris keeps its values
                    current while the server runs.
                </p>
            </div>
            {control}
        </div>
    );
}

export function MinecraftSidebar({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    // What this tab last read paints first, so the panel is there at once on a
    // revisit; the read below replaces it when it moved.
    const stateKey = `live-display:${installedAppId}`;
    const [state, setState] = useState<LiveDisplayState | null>(null);
    const [draft, setDraft] = useState<side.SidebarConfig>(side.DEFAULT_SIDEBAR);
    const draftNow = useRef(draft);
    draftNow.current = draft;
    /** Whether the server has answered, after which the kept copy has no say.
     *  Until then the kept panel is shown but cannot be changed or saved: a draft
     *  is only ever started from what the server holds. */
    const [heard, setHeard] = useState(false);
    const answered = useRef(false);
    /** The "several leaderboards, taking turns" dialog, while it is open. */
    const [rotating, setRotating] = useState<Rotating | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // Moving a line changes the panel on the next save, like any other edit:
    // Polaris rewrites the lines on the running server, no restart.
    const order = useListOrder(side.DEFAULT_SIDEBAR.lines.length, (from, to) =>
        setDraft((current) => ({ ...current, lines: moved(current.lines, from, to) }))
    );
    const { reset: resetOrder } = order;

    const load = useCallback(
        (next: LiveDisplayState) => {
            answered.current = true;
            setHeard(true);
            setState(next);
            setDraft(next.sidebar);
            resetOrder(next.sidebar.lines.length);
            writeSnapshot(stateKey, next);
        },
        [resetOrder, stateKey]
    );

    useKeptSnapshot<LiveDisplayState>(stateKey, KEPT_DISPLAY_MS, (kept) => {
        if (answered.current) return;
        setState(kept.value);
        setDraft(kept.value.sidebar);
        resetOrder(kept.value.sidebar.lines.length);
    });

    useEffect(() => {
        void readLiveDisplayAction(installedAppId).then((answer) => {
            const fresh = answer.state;
            if (!fresh) {
                setError(answer.error ?? "The panel could not be read");
                if (!answered.current) {
                    setState(null);
                    setDraft(side.DEFAULT_SIDEBAR);
                    resetOrder(side.DEFAULT_SIDEBAR.lines.length);
                }
                return;
            }
            // A save already answered with a newer panel than this read.
            if (answered.current) return;
            answered.current = true;
            setHeard(true);
            setState((current) => mergeUnchanged(current, fresh));
            writeSnapshot(stateKey, fresh);
            // Nothing could be typed before this answer, so the draft is the kept
            // panel and moves to the server's only where the two differ.
            if (JSON.stringify(draftNow.current) === JSON.stringify(fresh.sidebar)) return;
            setDraft(fresh.sidebar);
            resetOrder(fresh.sidebar.lines.length);
        });
    }, [installedAppId, stateKey, resetOrder]);

    const known = state?.known;
    const problems = useMemo(() => side.sidebarProblems(draft, known), [draft, known]);
    const invalid = side.hasSidebarProblems(draft, known);
    // Only a change is worth a save: the same panel saved again is a round trip
    // that changes nothing on anybody's screen.
    const dirty = state !== null && JSON.stringify(draft) !== JSON.stringify(state.sidebar);
    const inserts = useMemo(() => insertsFor("java", "server"), []);
    /** Changing the panel waits for the server's answer, as the form did when
     *  it was only drawn after it. */
    const editable = canManage && heard;

    const change = (patch: Partial<side.SidebarConfig>) => {
        setDraft((current) => ({ ...current, ...patch }));
        setNote(null);
    };
    const setLine = (index: number, value: side.SidebarLine) =>
        change({ lines: draft.lines.map((line, at) => (at === index ? value : line)) });
    /** Lines added at the end, told to the drag order so it keeps up. */
    const addLines = (next: side.SidebarLine[] | null) => {
        if (!next) return;
        for (let added = draft.lines.length; added < next.length; added += 1) order.added();
        change({ lines: next });
    };

    function save(): void {
        setError(null);
        startTransition(async () => {
            const result = await saveLiveDisplayAction({
                installedAppId,
                sidebar: { ...draft, lines: [...draft.lines] }
            });
            if (result.error || !result.state) {
                setError(result.error ?? "That could not be saved");
                return;
            }
            load(result.state);
            setNote(
                result.state.sidebar.enabled ? "On every screen now." : "Saved. The panel is off."
            );
        });
    }

    // What the card is and what it does are drawn at once; only the switch and
    // the lines wait for the server's panel to be read, and a read that failed
    // says so in their place.
    if (!state) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <SidebarHeading
                        control={
                            error ? null : <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                        }
                    />
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : (
                        <div className="flex flex-col gap-3" aria-busy="true">
                            <Skeleton className="h-9 w-full" />
                            <Skeleton className="h-9 w-full" />
                            <Skeleton className="h-9 w-2/3" />
                        </div>
                    )}
                </CardBody>
            </Card>
        );
    }

    const refused = state.sidebarRefusal;
    return (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
                <Card>
                    <CardBody className="flex flex-col gap-4">
                        <SidebarHeading
                            control={
                                <Switch
                                    checked={draft.enabled}
                                    disabled={!editable || (refused !== null && !draft.enabled)}
                                    onChange={(enabled) => change({ enabled })}
                                    aria-label="Show the side panel"
                                />
                            }
                        />
                        {refused && <p className="text-xs text-muted-foreground">{refused}.</p>}

                        <div className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">Title</span>
                            <SidebarLineEditor
                                line={draft.title}
                                onChange={(title) => change({ title })}
                                label="Title"
                                fits={side.SIDEBAR_TITLE_MAX}
                                problems={problems.title}
                                known={known}
                                inserts={inserts}
                                disabled={!editable}
                            />
                        </div>

                        <div
                            className="flex flex-col gap-3"
                            {...(editable ? order.listProps : {})}
                        >
                            <span className="flex items-baseline gap-2">
                                <span className="text-sm font-medium">Lines</span>
                                <span className="text-xs text-muted-foreground">
                                    {draft.lines.length}/{side.SIDEBAR_LINES_MAX}
                                </span>
                            </span>
                            {draft.lines.map((line, index) => (
                                <div
                                    key={order.ids[index] ?? `line-${index}`}
                                    className={cn(
                                        "relative flex items-start gap-1 rounded-md transition-opacity",
                                        order.dragging === index && "opacity-40"
                                    )}
                                    {...(editable ? order.rowProps(index) : {})}
                                >
                                    {/* Where the dragged line would land. */}
                                    {order.dragging !== null && order.dropAt === index && (
                                        <span className="pointer-events-none absolute inset-x-0 -top-1.5 h-0.5 rounded-full bg-primary" />
                                    )}
                                    {order.dragging !== null &&
                                        order.dropAt === draft.lines.length &&
                                        index === draft.lines.length - 1 && (
                                            <span className="pointer-events-none absolute inset-x-0 -bottom-1.5 h-0.5 rounded-full bg-primary" />
                                        )}
                                    {editable && draft.lines.length > 1 && (
                                        <button
                                            type="button"
                                            {...order.handleProps(index, draft.lines.length)}
                                            className="mt-1.5 flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                                            aria-label={`Move line ${index + 1}. Drag it, or use the up and down arrow keys`}
                                            title="Drag to move, or use the arrow keys"
                                        >
                                            <GripVertical className="size-4" />
                                        </button>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <SidebarLineEditor
                                            line={line}
                                            onChange={(value) => setLine(index, value)}
                                            label={`Line ${index + 1}`}
                                            fits={side.SIDEBAR_LINE_MAX}
                                            problems={problems.lines[index] ?? []}
                                            known={known}
                                            placeholder="Leave empty for a gap"
                                            inserts={inserts}
                                            disabled={!editable}
                                        />
                                        {editable && rotatingBlocksAt(draft.lines, index) ? (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="mt-1"
                                                onClick={() => {
                                                    const pair = rotatingBlocksAt(
                                                        draft.lines,
                                                        index
                                                    );
                                                    if (pair) setRotating({ ...pair, at: index });
                                                }}
                                            >
                                                <Trophy className="size-4" /> Choose the
                                                leaderboards taking turns here
                                            </Button>
                                        ) : null}
                                    </div>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        disabled={!heard}
                                        onClick={() => {
                                            order.removed(index);
                                            change({
                                                lines: draft.lines.filter((_, at) => at !== index)
                                            });
                                        }}
                                        aria-label={`Remove line ${index + 1}`}
                                        title={`Remove line ${index + 1}`}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            ))}
                            {problems.count && (
                                <p role="alert" className="text-xs text-danger">
                                    {problems.count}
                                </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={
                                        !heard || draft.lines.length >= side.SIDEBAR_LINES_MAX
                                    }
                                    onClick={() => addLines([...draft.lines, side.plainLine("")])}
                                >
                                    <Plus className="size-4" /> Add a line
                                </Button>
                                {/* The rankings and the last death, a heading and the
                                list under it, for somebody who does not know the
                                variables by name. */}
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={
                                                !heard ||
                                                draft.lines.length + 2 > side.SIDEBAR_LINES_MAX
                                            }
                                        >
                                            <Trophy className="size-4" /> Add a leaderboard
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                        align="start"
                                        className="max-h-80 overflow-y-auto"
                                    >
                                        {SIDEBAR_BLOCKS.map((block) => (
                                            <DropdownMenuItem
                                                key={block.id}
                                                onSelect={() =>
                                                    addLines(
                                                        withBlock(
                                                            draft.lines,
                                                            block,
                                                            side.SIDEBAR_LINES_MAX
                                                        )
                                                    )
                                                }
                                            >
                                                {block.label}
                                            </DropdownMenuItem>
                                        ))}
                                        <DropdownMenuSeparator />
                                        {/* Opened after the menu has closed: a dialog
                                            asked for from inside the menu would lose
                                            its focus to the menu handing it back. */}
                                        <DropdownMenuItem
                                            onSelect={() =>
                                                setTimeout(
                                                    () =>
                                                        setRotating({
                                                            ids: SIDEBAR_BLOCKS.slice(0, 2).map(
                                                                (block) => block.id
                                                            ),
                                                            every: side.SIDEBAR_EVERY_DEFAULT * 2,
                                                            at: null
                                                        }),
                                                    0
                                                )
                                            }
                                        >
                                            Several, taking turns...
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                An empty line is a gap. Drag one under the title to space it from
                                the lines below. Type {"{"} in a line for any value: players online,
                                the call, the last death, a leaderboard. Animate makes a line take
                                turns between texts or move.
                            </p>
                        </div>

                        {/* Whose call it is lives on the server's Linked chat screen,
                            with everything else that chat is used for. */}
                        <p className="text-xs text-muted-foreground">
                            {state.callLinked
                                ? "{call.count}, {call.members} and {call.max} read the call of the chat this server is linked to. "
                                : "{call.count}, {call.members} and {call.max} need a chat with a call. "}
                            <a
                                href={`/apps/installed/${installedAppId}/chat`}
                                className="font-medium text-foreground underline-offset-2 hover:underline"
                            >
                                {state.callLinked
                                    ? "Change it in Linked chat"
                                    : "Link one in Linked chat"}
                            </a>
                        </p>

                        {error && (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">
                                {note ??
                                    (canManage
                                        ? ""
                                        : "Only somebody who manages this server can change it.")}
                            </span>
                            <Button
                                disabled={!editable || pending || invalid || !dirty}
                                onClick={save}
                            >
                                {pending && <Loader2 className="size-4 animate-spin" />}
                                Save
                            </Button>
                        </div>
                    </CardBody>
                </Card>
            </div>

            {rotating ? (
                <RotatingDialog
                    rotating={rotating}
                    onChange={setRotating}
                    room={draft.lines.length + 2 <= side.SIDEBAR_LINES_MAX}
                    onDone={(blocks) => {
                        if (rotating.at === null) {
                            addLines(
                                withRotatingBlocks(
                                    draft.lines,
                                    blocks,
                                    rotating.every,
                                    side.SIDEBAR_LINES_MAX
                                )
                            );
                        } else {
                            const next = withRotatingBlocksAt(
                                draft.lines,
                                rotating.at,
                                blocks,
                                rotating.every
                            );
                            if (next) change({ lines: next });
                        }
                        setRotating(null);
                    }}
                />
            ) : null}

            {/* The preview kept in view, and what can be written in the room
                under it that the longer form beside it leaves. */}
            <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-[calc(var(--header-height)+1rem)] lg:max-h-[calc(100dvh-var(--header-height)-2rem)] lg:self-start">
                <SidebarPreview sidebar={draft} />
                <VariablesHelp edition="java" scope="server" className="lg:min-h-0" />
            </div>
        </div>
    );
}

/** The leaderboards being chosen to take turns: for a new pair, or for the
 *  pair already at line `at`. */
interface Rotating {
    readonly ids: string[];
    readonly every: number;
    readonly at: number | null;
}

/**
 * Which leaderboards take turns, and for how long each. Chosen the way files
 * are in an explorer: a press takes or leaves one, Shift with a press a whole
 * stretch, Ctrl+A everything. The number beside each is its turn.
 */
function RotatingDialog({
    rotating,
    onChange,
    room,
    onDone
}: {
    rotating: Rotating;
    onChange: (next: Rotating | null) => void;
    /** Whether the panel has room for two more lines, for a new pair. */
    room: boolean;
    onDone: (blocks: SidebarBlock[]) => void;
}) {
    const everyId = useMemo(() => SIDEBAR_BLOCKS.map((block) => block.id), []);
    const setIds = useCallback(
        (ids: string[]) => onChange({ ...rotating, ids: ids.slice(0, side.SIDEBAR_FRAMES_MAX) }),
        [onChange, rotating]
    );
    const selection = useRangeSelection(everyId, rotating.ids, setIds);
    const editing = rotating.at !== null;
    const chosen = rotating.ids.flatMap(
        (id) => SIDEBAR_BLOCKS.find((block) => block.id === id) ?? []
    );

    return (
        <Dialog open onOpenChange={(open: boolean) => !open && onChange(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Leaderboards taking turns</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                    Two lines that show each of these in turn: its heading, and the list under it.
                    Shift-click takes a whole stretch, Ctrl+A all of them.
                </p>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                        {rotating.ids.length} of {SIDEBAR_BLOCKS.length} chosen
                    </span>
                    <span className="flex gap-1">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setIds(allChosen(everyId, rotating.ids))}
                        >
                            Choose all
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            disabled={rotating.ids.length === 0}
                            onClick={() => setIds([])}
                        >
                            Clear
                        </Button>
                    </span>
                </div>
                <ul
                    className="grid max-h-72 select-none gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2"
                    onKeyDown={selection.onKeyDown}
                    aria-label="Leaderboards"
                >
                    {SIDEBAR_BLOCKS.map((block) => {
                        const turn = rotating.ids.indexOf(block.id);
                        return (
                            <li key={block.id}>
                                <label
                                    className="flex cursor-pointer items-center gap-2 text-sm"
                                    onClick={(event) => {
                                        // A press on the words is taken here, with the keys
                                        // held during it, rather than handed on to the box
                                        // as a click that would not carry Shift. A press on
                                        // the box is the box's own.
                                        if (event.target instanceof HTMLInputElement) return;
                                        event.preventDefault();
                                        selection.press(block.id, event);
                                    }}
                                >
                                    <Checkbox
                                        checked={turn >= 0}
                                        onChange={() => undefined}
                                        onClick={(event) => selection.press(block.id, event)}
                                    />
                                    <span className="min-w-0 flex-1 truncate">{block.label}</span>
                                    {turn >= 0 ? (
                                        <span
                                            className="shrink-0 text-xs tabular-nums text-muted-foreground"
                                            title="Its turn"
                                        >
                                            {turn + 1}
                                        </span>
                                    ) : null}
                                </label>
                            </li>
                        );
                    })}
                </ul>
                <label className="flex items-center gap-2 text-sm">
                    Each for
                    <WholeNumberInput
                        min={side.SIDEBAR_EVERY_MIN}
                        max={side.SIDEBAR_EVERY_MAX}
                        value={rotating.every}
                        onValueChange={(every) => onChange({ ...rotating, every })}
                        className="h-8 w-20"
                        aria-label="Seconds each leaderboard shows"
                    />
                    seconds
                </label>
                {rotating.ids.length < 2 ? (
                    <p className="text-xs text-muted-foreground">Choose at least two.</p>
                ) : !editing && !room ? (
                    <p className="text-xs text-danger">
                        The panel has no room for two more lines. Remove one first.
                    </p>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onChange(null)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={chosen.length < 2 || (!editing && !room)}
                        onClick={() => onDone(chosen)}
                    >
                        {editing ? "Save" : "Add"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Two rows of each list, for how a line of one spreads out. */
const SAMPLE_LISTS: Readonly<Record<string, readonly string[]>> = {
    "server.levels": ["Steve Lv 12", "Alex Lv 5"],
    "rank.level": ["1. Steve 12", "2. Alex 5"],
    ...Object.fromEntries(STATS_RANKINGS.map((name) => [name, RANKINGS[name].sample])),
    [EVENTS_RANKING]: ["1. Steve 7", "2. Alex 3"]
};

/** How often the preview is drawn again while something on it moves: often
 *  enough for the fastest step an effect has. */
const PREVIEW_EVERY_MS = 250;

/** The time, moving on while `moving`, standing still otherwise. */
function useClock(moving: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!moving) return;
        const timer = setInterval(() => setNow(Date.now()), PREVIEW_EVERY_MS);
        return () => clearInterval(timer);
    }, [moving]);
    return now;
}

/** The panel as it will read, every value at a sample - moving the way it will. */
function SidebarPreview({ sidebar }: { sidebar: side.SidebarConfig }) {
    const now = useClock(side.animationPeriod(sidebar) !== null);
    const shown = renderSidebar(sidebar, now, previewText, SAMPLE_LISTS);
    const title = mc.motdSpans(shown.title)[0] ?? [];
    return (
        <Card className="shrink-0">
            <CardBody className="flex flex-col gap-2">
                <p className="text-sm font-medium">Preview</p>
                <div className="flex min-h-40 justify-end rounded-md bg-[#6b8f4e] p-3">
                    <div
                        className="self-center bg-black/40 px-2 py-1 font-mono text-[13px] leading-5 text-white"
                        aria-label="Preview of the side panel"
                    >
                        <div className="text-center">
                            <McLine spans={title} />
                        </div>
                        {shown.lines.map((line, index) => (
                            <div key={index} className="min-h-5 whitespace-pre">
                                <McLine spans={mc.motdSpans(line)[0] ?? []} />
                            </div>
                        ))}
                    </div>
                </div>
                {!sidebar.enabled && (
                    <p className="text-xs text-muted-foreground">
                        Off: nobody sees it until it is switched on.
                    </p>
                )}
            </CardBody>
        </Card>
    );
}

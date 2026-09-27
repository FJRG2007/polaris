"use client";

/**
 * The side panel: the box on the right of every player's screen, written by
 * Polaris and kept current - who is online, who is in the call of a chat group,
 * anything the server's own variables can say.
 *
 * Checked as it is typed with the rules the save uses (`sidebar.ts`), and
 * previewed with sample values - moving, where a line takes turns or has an
 * effect, drawn by the same function the server draws it with. Only the
 * server's variables are offered: the panel is the same for everybody, so
 * nothing of one player's can go on it.
 */

import * as mc from "../../lib/minecraft/motd";
import { McLine } from "../../components/mc-text";
import { insertsFor } from "./minecraft-announce";
import { SidebarLineEditor } from "./sidebar-line-editor";
import { previewText } from "../../lib/minecraft/text-vars";
import { renderSidebar } from "../../lib/minecraft/sidebar-render";
import { moved, useListOrder } from "../../components/use-list-order";
import { WholeNumberInput } from "../../components/whole-number-input";
import { GripVertical, Loader2, Plus, Trash2, Trophy } from "lucide-react";
import { SIDEBAR_BLOCKS, withBlock, withRotatingBlocks } from "../../lib/minecraft/sidebar-blocks";
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
    Select,
    Switch,
    cn
} from "@polaris/ui";
import * as side from "../../lib/minecraft/sidebar";
import { VariablesHelp } from "../../components/variables-help";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
    readLiveDisplayAction,
    saveLiveDisplayAction,
    type LiveDisplayState
} from "./live-display-actions";

/** "No group" as a select value: an empty value reads as nothing chosen. */
const NO_GROUP = "none";

export function MinecraftSidebar({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const [state, setState] = useState<LiveDisplayState | null>(null);
    const [draft, setDraft] = useState<side.SidebarConfig>(side.DEFAULT_SIDEBAR);
    /** The "several leaderboards, taking turns" dialog, while it is open. */
    const [rotating, setRotating] = useState<{ ids: string[]; every: number } | null>(null);
    const [group, setGroup] = useState<string | null>(null);
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
            setState(next);
            setDraft(next.sidebar);
            setGroup(next.callGroupId);
            resetOrder(next.sidebar.lines.length);
        },
        [resetOrder]
    );

    useEffect(() => {
        void readLiveDisplayAction(installedAppId).then((answer) => {
            if (answer.state) load(answer.state);
            else setError(answer.error ?? "The panel could not be read");
        });
    }, [installedAppId, load]);

    const problems = useMemo(() => side.sidebarProblems(draft), [draft]);
    const invalid = side.hasSidebarProblems(draft);
    // Only a change is worth a save: the same panel saved again is a round trip
    // that changes nothing on anybody's screen.
    const dirty =
        state !== null &&
        (JSON.stringify(draft) !== JSON.stringify(state.sidebar) || group !== state.callGroupId);
    const inserts = useMemo(() => insertsFor("java", "server"), []);

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
                sidebar: { ...draft, lines: [...draft.lines] },
                callGroupId: group
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

    if (!state) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Side panel</p>
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : (
                        <div className="h-24 animate-pulse rounded-md bg-muted" />
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
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-medium">Side panel</p>
                                <p className="text-xs text-muted-foreground">
                                    A box on the right of every player&apos;s screen. Polaris keeps
                                    its values current while the server runs.
                                </p>
                            </div>
                            <Switch
                                checked={draft.enabled}
                                disabled={!canManage || (refused !== null && !draft.enabled)}
                                onChange={(enabled) => change({ enabled })}
                                aria-label="Show the side panel"
                            />
                        </div>
                        {refused && <p className="text-xs text-muted-foreground">{refused}.</p>}

                        <div className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">Title</span>
                            <SidebarLineEditor
                                line={draft.title}
                                onChange={(title) => change({ title })}
                                label="Title"
                                fits={side.SIDEBAR_TITLE_MAX}
                                problems={problems.title}
                                inserts={inserts}
                                disabled={!canManage}
                            />
                        </div>

                        <div className="flex flex-col gap-3">
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
                                    {...(canManage ? order.rowProps(index) : {})}
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
                                    {canManage && draft.lines.length > 1 && (
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
                                            placeholder="Leave empty for a gap"
                                            inserts={inserts}
                                            disabled={!canManage}
                                        />
                                    </div>
                                    <Button
                                        size="icon"
                                        variant="ghost"
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
                                    disabled={draft.lines.length >= side.SIDEBAR_LINES_MAX}
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
                                                draft.lines.length + 2 > side.SIDEBAR_LINES_MAX
                                            }
                                        >
                                            <Trophy className="size-4" /> Add a leaderboard
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="start">
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
                                                            every: side.SIDEBAR_EVERY_DEFAULT * 2
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

                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Chat group for {"{call.*}"}</span>
                            <Select
                                value={group ?? NO_GROUP}
                                onValueChange={(value) => {
                                    setGroup(value === NO_GROUP ? null : value);
                                    setNote(null);
                                }}
                                options={[
                                    { value: NO_GROUP, label: "None" },
                                    ...state.groups.map((one) => ({
                                        value: one.id,
                                        label: one.name
                                    })),
                                    ...(state.callGroupId &&
                                    !state.groups.some((one) => one.id === state.callGroupId)
                                        ? [
                                              {
                                                  value: state.callGroupId,
                                                  label: "A group you are not in"
                                              }
                                          ]
                                        : [])
                                ]}
                                aria-label="Chat group whose call is shown"
                            />
                            <span className="text-xs text-muted-foreground">
                                {state.groups.length === 0
                                    ? "You are in no chat group yet. Create one in Chat to show who is in its call."
                                    : "Whose call {call.count}, {call.members} and {call.max} read, here and in announcements."}
                            </span>
                        </label>

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
                                disabled={!canManage || pending || invalid || !dirty}
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
                <Dialog open onOpenChange={(open: boolean) => !open && setRotating(null)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Leaderboards taking turns</DialogTitle>
                        </DialogHeader>
                        <p className="text-sm text-muted-foreground">
                            Two lines that show each of these in turn: its heading, and the list
                            under it.
                        </p>
                        <ul className="flex flex-col gap-1.5">
                            {SIDEBAR_BLOCKS.map((block) => (
                                <li key={block.id}>
                                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                                        <Checkbox
                                            checked={rotating.ids.includes(block.id)}
                                            onChange={(event) =>
                                                setRotating({
                                                    ...rotating,
                                                    ids: event.target.checked
                                                        ? [...rotating.ids, block.id].slice(
                                                              0,
                                                              side.SIDEBAR_FRAMES_MAX
                                                          )
                                                        : rotating.ids.filter(
                                                              (id) => id !== block.id
                                                          )
                                                })
                                            }
                                        />
                                        {block.label}
                                    </label>
                                </li>
                            ))}
                        </ul>
                        <label className="flex items-center gap-2 text-sm">
                            Each for
                            <WholeNumberInput
                                min={side.SIDEBAR_EVERY_MIN}
                                max={side.SIDEBAR_EVERY_MAX}
                                value={rotating.every}
                                onValueChange={(every) => setRotating({ ...rotating, every })}
                                className="h-8 w-20"
                                aria-label="Seconds each leaderboard shows"
                            />
                            seconds
                        </label>
                        {rotating.ids.length < 2 ? (
                            <p className="text-xs text-muted-foreground">Choose at least two.</p>
                        ) : null}
                        <DialogFooter>
                            <Button variant="ghost" onClick={() => setRotating(null)}>
                                Cancel
                            </Button>
                            <Button
                                disabled={
                                    rotating.ids.length < 2 ||
                                    draft.lines.length + 2 > side.SIDEBAR_LINES_MAX
                                }
                                onClick={() => {
                                    addLines(
                                        withRotatingBlocks(
                                            draft.lines,
                                            SIDEBAR_BLOCKS.filter((block) =>
                                                rotating.ids.includes(block.id)
                                            ),
                                            rotating.every,
                                            side.SIDEBAR_LINES_MAX
                                        )
                                    );
                                    setRotating(null);
                                }}
                            >
                                Add
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
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

/** Two rows of each list, for how a line of one spreads out. */
const SAMPLE_LISTS: Readonly<Record<string, readonly string[]>> = {
    "server.levels": ["Steve Lv 12", "Alex Lv 5"],
    "rank.level": ["1. Steve 12", "2. Alex 5"],
    "rank.deaths": ["1. Steve 42", "2. Alex 30"],
    "rank.kills": ["1. Alex 812", "2. Steve 640"],
    "rank.pvp": ["1. Alex 9", "2. Steve 4"],
    "rank.playtime": ["1. Steve 120h", "2. Alex 86h"]
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

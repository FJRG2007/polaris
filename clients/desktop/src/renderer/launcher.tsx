/**
 * The launcher's page: the dashboard's own search panel (`@polaris/ui`'s
 * `search-panel`, the component the command palette draws), fed with the rows
 * the main process sends for what is typed. It draws and reports a choice; what
 * a choice does is the main process's (`main/launcher`).
 *
 * The window covers the work area of the screen the pointer is on and is
 * transparent, so the panel sits where the dashboard's palette sits in a
 * browser window: centred both ways, the same width, border, radius and shadow.
 */

import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LauncherRowAction } from "@/shared/game-kinds";
import type { LauncherRow, LauncherRowKind, PolarisLauncher } from "@/shared/launcher";
import { highlightAfter } from "@/shared/launcher";
import { groupRows, searchTerms, stepActive } from "../../../../dashboard/packages/ui/src/search/search-match";
import { AppWindow, Calculator, ClipboardList, Compass, Gamepad2, Globe, Link, Power, Search, Sparkles, type LucideIcon } from "lucide-react";
import { SearchGroup, SearchItem, SearchMessage, SearchOption, SearchSheet } from "../../../../dashboard/packages/ui/src/search/search-panel";
import { KEY_GLYPHS, KeyHint, type HintKey } from "../../../../dashboard/packages/ui/src/shortcuts/key-cap";

/** The footer's keys, drawn as caps as Raycast's footer draws them. */
const MOVE_KEYS: readonly HintKey[] = [
    { cap: KEY_GLYPHS.up, name: "Up arrow" },
    { cap: KEY_GLYPHS.down, name: "Down arrow" }
];
const OPEN_KEYS: readonly HintKey[] = [{ cap: KEY_GLYPHS.enter, name: "Enter" }];
const CLOSE_KEYS: readonly HintKey[] = [{ cap: "Esc", name: "Escape" }];
const IS_MAC = /Mac/i.test(navigator.userAgent);
const ACTION_KEYS: readonly HintKey[] = [
    IS_MAC ? { cap: "\u2318", name: "Command" } : { cap: "Ctrl", name: "Control" },
    { cap: "K", name: "K" }
];

/** The panel's words, in one place for a translation (Raycast's action names). */
const TEXT = {
    actions: "Actions",
    open: "Open",
    back: "Back",
    actionsOf: (title: string) => `Actions for ${title}`,
    action: { "treat-as-game": "Treat as Game", "treat-as-app": "Treat as Application" } satisfies Record<LauncherRowAction, string>
} as const;

const ACTION_ICONS: Readonly<Record<LauncherRowAction, LucideIcon>> = { "treat-as-game": Gamepad2, "treat-as-app": AppWindow };

/** One entry of a row's action panel: opening it first, as Enter does, then what else it can do. */
interface PanelEntry {
    readonly id: "open" | LauncherRowAction;
    readonly label: string;
}

function panelEntries(row: LauncherRow): PanelEntry[] {
    return [{ id: "open", label: TEXT.open }, ...(row.actions ?? []).map((id) => ({ id, label: TEXT.action[id] }))];
}

/** Ctrl+K, or Cmd+K on a Mac: the key Raycast opens a row's actions with. */
function isActionsKey(event: KeyboardEvent<HTMLInputElement>): boolean {
    return event.key.toLowerCase() === "k" && (IS_MAC ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey;
}

declare global {
    interface Window {
        readonly polarisLauncher: PolarisLauncher;
    }
}

/** Each kind's heading and icon, in the order the main process ranks them. */
const KINDS: Readonly<Record<LauncherRowKind, { label: string; icon: LucideIcon; }>> = {
    url: { label: "Link", icon: Link },
    answer: { label: "Answer", icon: Calculator },
    polaris: { label: "Polaris", icon: Search },
    page: { label: "Pages", icon: Compass },
    system: { label: "System", icon: Power },
    app: { label: "Apps", icon: AppWindow },
    polar: { label: "Polar", icon: Sparkles },
    web: { label: "Web", icon: Globe },
    clip: { label: "Clipboard", icon: ClipboardList }
};

const LIST_ID = "launcher-results";

function rowId(index: number): string {
    return `launcher-row-${index}`;
}

function entryId(index: number): string {
    return `launcher-action-${index}`;
}

const FOOTER_BUTTON = "rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground";

function Launcher() {
    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<readonly LauncherRow[]>([]);
    const [notice, setNotice] = useState<string | null>(null);
    const [active, setActive] = useState(0);
    const [answered, setAnswered] = useState(false);
    /** The row whose actions are listed instead of the results (Raycast's action panel), and the entry the keys are on. */
    const [panel, setPanel] = useState<{ row: LauncherRow; version: number; active: number; } | null>(null);
    /** The number of the answer the rows on screen came from, which an action names. */
    const [version, setVersion] = useState<number | null>(null);
    const field = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    /** Each query numbered, so a slow answer never replaces a newer one. */
    const asked = useRef(0);
    /** The text the rows on screen answered, and the id of the row highlighted in them. */
    const answeredText = useRef<string | null>(null);
    const highlighted = useRef<string | null>(null);

    /** `keep`: the row the keys stay on, after an action changed the list under them. */
    const search = useCallback(async (text: string, keep = 0) => {
        const mine = ++asked.current;
        const answer = await window.polarisLauncher.query(text).catch(() => null);
        if (mine !== asked.current || !answer) return;
        // The same text answered again (a late source, an action's refresh)
        // keeps the highlight on the row the reader was looking at, wherever
        // it moved to; a new text starts at the top.
        const same = answeredText.current === text;
        const at = highlightAfter(answer.rows, highlighted.current, same, keep);
        answeredText.current = text;
        setRows(answer.rows);
        setVersion(answer.version ?? null);
        setNotice(answer.notice);
        setActive(at);
        setAnswered(true);
    }, []);

    useEffect(() => {
        void search("");
        window.polarisLauncher.onOpened((typed) => {
            setPanel(null);
            setQuery(typed);
            void search(typed);
            field.current?.focus();
        });
    }, [search]);

    useEffect(() => {
        list.current?.querySelector(`#${rowId(active)}`)?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const change = (text: string) => {
        setPanel(null);
        setQuery(text);
        void search(text);
    };
    const choose = (index: number) => {
        const row = rows[index];
        if (row) void window.polarisLauncher.run(row.id);
    };
    const clearClips = () => {
        void window.polarisLauncher.clearClipboard().then(() => search(query));
        field.current?.focus();
    };
    const activeRow = rows[active];
    highlighted.current = activeRow?.id ?? null;
    const hasActions = Boolean(activeRow?.actions?.length && window.polarisLauncher.act && version !== null);
    const openPanel = () => {
        if (activeRow && hasActions && version !== null) setPanel({ row: activeRow, version, active: 0 });
        field.current?.focus();
    };
    const closePanel = () => {
        setPanel(null);
        field.current?.focus();
    };
    const runEntry = (entry: PanelEntry) => {
        if (!panel) return;
        const at = rows.findIndex((row) => row.id === panel.row.id);
        setPanel(null);
        if (entry.id === "open") {
            if (at >= 0) choose(at);
            return;
        }
        void window.polarisLauncher.act?.(panel.row.id, entry.id, panel.version).then(() => search(query, Math.max(0, at)));
        field.current?.focus();
    };
    const onPanelKey = (event: KeyboardEvent<HTMLInputElement>, open: { row: LauncherRow; version: number; active: number; }) => {
        const entries = panelEntries(open.row);
        const next = stepActive(event.key, open.active, entries.length);
        if (next !== null) {
            event.preventDefault();
            setPanel({ ...open, active: next });
        } else if (event.key === "Enter") {
            event.preventDefault();
            const entry = entries[open.active];
            if (entry) runEntry(entry);
        } else if (event.key === "Escape" || isActionsKey(event)) {
            event.preventDefault();
            closePanel();
        }
    };
    const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
        if (panel) return onPanelKey(event, panel);
        if (isActionsKey(event)) {
            event.preventDefault();
            openPanel();
            return;
        }
        const next = stepActive(event.key, active, rows.length);
        if (next !== null) {
            event.preventDefault();
            setActive(next);
        } else if (event.key === "Enter") {
            // Enter that confirms an IME candidate is not a command to run.
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            choose(active);
        } else if (event.key === "Escape") {
            event.preventDefault();
            if (query) change("");
            else void window.polarisLauncher.hide();
        }
    };

    const terms = searchTerms(query);
    const groups = groupRows(rows, (row) => KINDS[row.kind].label);
    const clips = rows.some((row) => row.kind === "clip");
    return (
        <SearchSheet
            title="Polaris search"
            dim={false}
            onClose={() => void window.polarisLauncher.hide()}
            query={query}
            onQueryChange={change}
            onFieldKeyDown={onKey}
            placeholder="Search Polaris, apps and the web, or type a sum"
            fieldLabel="Search"
            fieldRef={field}
            fieldProps={{ enterKeyHint: "go" }}
            activeId={panel ? entryId(panel.active) : rows.length ? rowId(active) : undefined}
            listId={LIST_ID}
            listLabel="Results"
            listRef={list}
            toolbar={
                notice ? (
                    <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{notice}</p>
                ) : null
            }
            footer={
                <>
                    <span className="flex min-w-0 items-center gap-3">
                        <KeyHint keys={MOVE_KEYS} label="Move" />
                        <KeyHint keys={OPEN_KEYS} label={TEXT.open} />
                    </span>
                    {panel ? (
                        <button type="button" onClick={closePanel} className={FOOTER_BUTTON}>
                            <KeyHint keys={CLOSE_KEYS} label={TEXT.back} />
                        </button>
                    ) : hasActions ? (
                        <button type="button" onClick={openPanel} className={FOOTER_BUTTON}>
                            <KeyHint keys={ACTION_KEYS} label={TEXT.actions} />
                        </button>
                    ) : clips ? (
                        <button
                            type="button"
                            onClick={clearClips}
                            className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                        >
                            Clear clipboard history
                        </button>
                    ) : (
                        <KeyHint keys={CLOSE_KEYS} label="Close" />
                    )}
                </>
            }
        >
            {panel ? (
                <SearchGroup label={TEXT.actionsOf(panel.row.title)}>
                    {panelEntries(panel.row).map((entry, position) => {
                        const Icon = entry.id === "open" ? (panel.row.game ? Gamepad2 : KINDS[panel.row.kind].icon) : ACTION_ICONS[entry.id];
                        return (
                            <SearchOption
                                key={entry.id}
                                id={entryId(position)}
                                selected={position === panel.active}
                                label={entry.label}
                                onSelect={() => runEntry(entry)}
                                onHover={() => setPanel({ ...panel, active: position })}
                            >
                                <SearchItem icon={<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />} label={entry.label} />
                            </SearchOption>
                        );
                    })}
                </SearchGroup>
            ) : rows.length === 0 ? (
                answered && query.trim() ? <SearchMessage>Nothing matches.</SearchMessage> : null
            ) : (
                groups.map((group) => (
                    <SearchGroup key={`${group.label}-${group.rows[0]?.position}`} label={group.label}>
                        {group.rows.map(({ row, position }) => {
                            const Icon = row.game ? Gamepad2 : KINDS[row.kind].icon;
                            return (
                                <SearchOption
                                    key={row.id}
                                    id={rowId(position)}
                                    selected={position === active}
                                    label={row.title}
                                    onSelect={() => choose(position)}
                                    onHover={() => setActive(position)}
                                >
                                    <SearchItem
                                        icon={
                                            row.icon ? (
                                                <img src={row.icon} alt="" width={18} height={18} className="size-[18px] shrink-0 object-contain" />
                                            ) : (
                                                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                            )
                                        }
                                        label={row.title}
                                        context={row.subtitle}
                                        terms={terms}
                                    />
                                </SearchOption>
                            );
                        })}
                    </SearchGroup>
                ))
            )}
        </SearchSheet>
    );
}

const mount = document.getElementById("root");
if (mount) createRoot(mount).render(<Launcher />);

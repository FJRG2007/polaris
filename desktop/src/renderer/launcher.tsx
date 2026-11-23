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
import type { LauncherRow, LauncherRowKind, PolarisLauncher } from "@/shared/launcher";
import { groupRows, searchTerms, stepActive } from "../../../dashboard/packages/ui/src/search/search-match";
import { AppWindow, Calculator, ClipboardList, Compass, Globe, Search, Sparkles, type LucideIcon } from "lucide-react";
import { SearchGroup, SearchItem, SearchMessage, SearchOption, SearchSheet } from "../../../dashboard/packages/ui/src/search/search-panel";

declare global {
    interface Window {
        readonly polarisLauncher: PolarisLauncher;
    }
}

/** Each kind's heading and icon, in the order the main process ranks them. */
const KINDS: Readonly<Record<LauncherRowKind, { label: string; icon: LucideIcon; }>> = {
    answer: { label: "Answer", icon: Calculator },
    polaris: { label: "Polaris", icon: Search },
    page: { label: "Pages", icon: Compass },
    app: { label: "Apps", icon: AppWindow },
    polar: { label: "Polar", icon: Sparkles },
    web: { label: "Web", icon: Globe },
    clip: { label: "Clipboard", icon: ClipboardList }
};

const LIST_ID = "launcher-results";

function rowId(index: number): string {
    return `launcher-row-${index}`;
}

function Launcher() {
    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<readonly LauncherRow[]>([]);
    const [notice, setNotice] = useState<string | null>(null);
    const [active, setActive] = useState(0);
    const [answered, setAnswered] = useState(false);
    const field = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    /** Each query numbered, so a slow answer never replaces a newer one. */
    const asked = useRef(0);

    const search = useCallback(async (text: string) => {
        const mine = ++asked.current;
        const answer = await window.polarisLauncher.query(text).catch(() => null);
        if (mine !== asked.current || !answer) return;
        setRows(answer.rows);
        setNotice(answer.notice);
        setActive(0);
        setAnswered(true);
    }, []);

    useEffect(() => {
        void search("");
        window.polarisLauncher.onOpened(() => {
            setQuery("");
            void search("");
            field.current?.focus();
        });
    }, [search]);

    useEffect(() => {
        list.current?.querySelector(`#${rowId(active)}`)?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const change = (text: string) => {
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
    const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
        const next = stepActive(event.key, active, rows.length);
        if (next !== null) {
            event.preventDefault();
            setActive(next);
        } else if (event.key === "Enter") {
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
            activeId={rows.length ? rowId(active) : undefined}
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
                    <span>Up and down to move, Enter to open</span>
                    {clips ? (
                        <button
                            type="button"
                            onClick={clearClips}
                            className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                        >
                            Clear clipboard history
                        </button>
                    ) : (
                        <span>Esc to close</span>
                    )}
                </>
            }
        >
            {rows.length === 0 ? (
                answered && query.trim() ? <SearchMessage>Nothing matches.</SearchMessage> : null
            ) : (
                groups.map((group) => (
                    <SearchGroup key={`${group.label}-${group.rows[0]?.position}`} label={group.label}>
                        {group.rows.map(({ row, position }) => {
                            const Icon = KINDS[row.kind].icon;
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
                                        icon={<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
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

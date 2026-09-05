"use client";

/**
 * The strip of what is open.
 *
 * It is a strip and not a segmented control because the number of things in it
 * is decided by the person, not by us: two tables one afternoon and nine the
 * next. So it scrolls sideways rather than squeezing every tab until the names
 * are unreadable - a tab whose label has been truncated to `us...` is a tab you
 * have to click to identify, which is the entire job of the label.
 *
 * The gestures are the ones every tabbed thing has, because a database client is
 * not where somebody wants to learn new ones: click to bring forward, middle
 * click to close, right click for the two closes that matter when there are too
 * many. The close cross is drawn on the tab in front and on whichever the
 * pointer is over, and it appears for the keyboard as soon as it is focused -
 * a control that only exists under a mouse is a control half the people using
 * this cannot reach.
 *
 * It deliberately does not claim to be an ARIA tablist. That contract owes the
 * reader arrow-key movement across a roving focus, which fights with the close
 * button living inside each tab; a row of ordinary buttons that says which one
 * is current is honest, reachable with Tab, and does not promise a keyboard
 * behaviour it fails to deliver.
 */

import type { WorkbenchTab } from "./workbench-tabs";
import { tabSubtitle, tabTitle } from "./workbench-tabs";
import { Activity, Plus, SquareTerminal, Table2, X } from "lucide-react";
import {
    Button,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    cn
} from "@polaris/ui";

export function TabStrip({
    tabs,
    activeId,
    shape,
    onFocus,
    onClose,
    onCloseOthers,
    onCloseAll,
    onNewQuery,
    onStats
}: {
    tabs: readonly WorkbenchTab[];
    activeId: string | null;
    /** What the database speaks, which decides whether a statement tab is
     *  called SQL or something vaguer. */
    shape: string;
    onFocus: (id: string) => void;
    onClose: (id: string) => void;
    onCloseOthers: (id: string) => void;
    onCloseAll: () => void;
    onNewQuery: () => void;
    onStats: () => void;
}) {
    return (
        <div className="flex items-end gap-1 border-b border-border">
            <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto pb-px">
                {tabs.map((tab) => {
                    const active = tab.id === activeId;
                    const title = tabTitle(tab, shape);
                    return (
                        <ContextMenu key={tab.id}>
                            <ContextMenuTrigger asChild>
                                <div
                                    className={cn(
                                        "group flex shrink-0 items-center rounded-t-md border-b-2 transition-colors",
                                        active
                                            ? "border-primary bg-card-hover text-foreground"
                                            : "border-transparent text-muted-foreground hover:bg-card-hover/60 hover:text-foreground"
                                    )}
                                    onAuxClick={(event) => {
                                        // The one gesture people do without
                                        // thinking about it.
                                        if (event.button !== 1) return;
                                        event.preventDefault();
                                        onClose(tab.id);
                                    }}
                                    onMouseDown={(event) => {
                                        // Otherwise the middle button starts the
                                        // browser's autoscroll on the way.
                                        if (event.button === 1) event.preventDefault();
                                    }}
                                >
                                    <button
                                        type="button"
                                        onClick={() => onFocus(tab.id)}
                                        aria-current={active ? "true" : undefined}
                                        title={tabSubtitle(tab) || title}
                                        className="flex max-w-[12rem] items-center gap-1.5 py-1.5 pl-2.5 pr-1 text-[0.8125rem]"
                                    >
                                        <TabIcon tab={tab} />
                                        <span className="truncate">{title}</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onClose(tab.id)}
                                        aria-label={`Close ${title}`}
                                        className={cn(
                                            "mr-1 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
                                            active ? "opacity-100" : "opacity-0"
                                        )}
                                    >
                                        <X className="size-3.5 shrink-0" />
                                    </button>
                                </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                                <ContextMenuItem onSelect={() => onClose(tab.id)}>Close</ContextMenuItem>
                                <ContextMenuItem
                                    onSelect={() => onCloseOthers(tab.id)}
                                    disabled={tabs.length < 2}
                                >
                                    Close the others
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem onSelect={onCloseAll}>Close everything</ContextMenuItem>
                            </ContextMenuContent>
                        </ContextMenu>
                    );
                })}
            </div>

            {/* Kept out of the scrolling half: these two are how anything gets
                opened that is not a table, and a control that scrolls out of
                reach once nine tabs are open is a control that is gone. */}
            <div className="flex shrink-0 items-center gap-0.5 pb-1 pl-1">
                <Button size="sm" variant="ghost" onClick={onNewQuery}>
                    <Plus className="size-4 shrink-0" />
                    {shape === "sql" ? "SQL" : "Command"}
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={onStats} title="Activity">
                    <Activity className="size-4 shrink-0" />
                    <span className="sr-only">Activity</span>
                </Button>
            </div>
        </div>
    );
}

function TabIcon({ tab }: { tab: WorkbenchTab }) {
    const className = "size-3.5 shrink-0";
    if (tab.kind === "table") return <Table2 className={className} />;
    if (tab.kind === "stats") return <Activity className={className} />;
    return <SquareTerminal className={className} />;
}

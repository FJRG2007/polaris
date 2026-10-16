"use client";

/**
 * The dialog a trigger, a condition or a step is added from, the same on every
 * surface: a search on top, and two panes below - the groups on the left, what
 * the chosen group holds on the right, each with what it does in a line.
 *
 * "By type" lists the surface's own kinds in their groups; "Blocks" lists the
 * pieces that shape an automation rather than watch or do something (only where
 * a surface has them); "By target" starts from a thing - a device, a service, a
 * mailbox - and offers only what applies to it, with the thing already chosen
 * (only where a surface hands it `targets`). When the clipboard holds a block
 * that fits, pasting it is the first thing offered.
 *
 * On a phone it is a sheet from the bottom with one pane at a time: the groups,
 * then the chosen group's items with a way back.
 *
 * The keyboard: typing goes to the search; Down moves from it into the results
 * and Up and Down move between them; Enter picks; Escape closes.
 */

import { cn } from "../lib/cn";
import { useWide } from "./blocks";
import { Input } from "../components/input";
import { Button } from "../components/button";
import * as RadixDialog from "@radix-ui/react-dialog";
import { Dialog, DialogContent } from "../components/dialog";
import { ArrowLeft, ChevronRight, ClipboardPaste, Search, X } from "lucide-react";
import {
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode
} from "react";

/** One thing that can be added. */
export interface AddItem {
    readonly value: string;
    readonly label: string;
    /** What it does, in a line. */
    readonly description?: string;
    readonly icon?: ReactNode;
}

/** A named group of items - or, on the target tab, of targets. */
export interface AddGroup {
    readonly id: string;
    readonly label: string;
    readonly icon?: ReactNode;
    readonly items: readonly AddItem[];
}

/** The things a surface's blocks can point at, and which blocks apply to each. */
export interface AddTargets {
    /** Targets in groups: a room's devices, a project's services. */
    readonly groups: readonly AddGroup[];
    /** The blocks that apply to one target, ready to be made with it chosen. */
    readonly itemsFor: (target: string) => readonly AddItem[];
}

export interface AddStrings {
    readonly search: string;
    readonly byTarget: string;
    readonly byType: string;
    readonly blocks: string;
    readonly back: string;
    readonly close: string;
    /** Shown when the search finds nothing; `{term}` is what was typed. */
    readonly noMatch: (term: string) => string;
    /** Shown on a target nothing can be added for. */
    readonly nothingForTarget: string;
    /** Shown when more results matched than the list shows. */
    readonly more: (count: number) => string;
}

type Tab = "target" | "type" | "blocks";

/** How many search results are listed before "and N more". */
const SEARCH_LIMIT = 40;

/** Whether `term` is in the item's words, ignoring case and accents. */
function matches(term: string, ...texts: (string | undefined)[]): boolean {
    const fold = (text: string) =>
        text
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase();
    const wanted = fold(term.trim());
    return texts.some((text) => text !== undefined && fold(text).includes(wanted));
}

/** Moves the focus to the next or previous option in `container`. */
function step(container: HTMLElement | null, from: Element | null, by: 1 | -1): boolean {
    if (!container) return false;
    const options = [...container.querySelectorAll<HTMLElement>("[data-add-option]")];
    if (options.length === 0) return false;
    const at = from ? options.indexOf(from as HTMLElement) : -1;
    const next = at === -1 ? (by === 1 ? 0 : options.length - 1) : at + by;
    if (next < 0 || next >= options.length) return false;
    options[next]!.focus();
    return true;
}

function Option({
    item,
    selected,
    trailing,
    onPick
}: {
    item: AddItem;
    selected?: boolean;
    trailing?: ReactNode;
    onPick: () => void;
}) {
    return (
        <li>
            <button
                type="button"
                data-add-option=""
                aria-current={selected || undefined}
                onClick={onPick}
                className={cn(
                    "flex w-full min-w-0 items-start gap-3 rounded-md px-2.5 py-2 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                    selected && "bg-muted"
                )}
            >
                {item.icon && (
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                        {item.icon}
                    </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium" title={item.label}>
                        {item.label}
                    </span>
                    {item.description && (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                            {item.description}
                        </span>
                    )}
                </span>
                {trailing}
            </button>
        </li>
    );
}

export function AddBlockDialog({
    open,
    title,
    strings,
    groups,
    blocks,
    targets,
    paste,
    onPick,
    onClose
}: {
    open: boolean;
    title: string;
    strings: AddStrings;
    /** The surface's kinds, grouped, for "By type". */
    groups: readonly AddGroup[];
    /** The pieces that shape an automation, for "Blocks". */
    blocks?: readonly AddItem[];
    targets?: AddTargets;
    /** Offered first when the clipboard holds a block that fits here. */
    paste?: { label: string; description?: string; onPaste: () => void };
    /** `target` is the thing chosen on "By target", when it was picked there. */
    onPick: (value: string, target?: string) => void;
    onClose: () => void;
}) {
    const wide = useWide("(min-width: 768px)");
    const tabs: Tab[] = [
        ...(targets ? (["target"] as const) : []),
        "type",
        ...(blocks && blocks.length > 0 ? (["blocks"] as const) : [])
    ];
    const [tab, setTab] = useState<Tab>(tabs[0]!);
    const [group, setGroup] = useState<string | null>(null);
    const [target, setTarget] = useState<string | null>(null);
    const [term, setTerm] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    const resultsRef = useRef<HTMLUListElement>(null);
    const groupsRef = useRef<HTMLUListElement>(null);
    const titleId = useId();

    // Every opening starts afresh: the first tab, its first group, no search.
    useEffect(() => {
        if (!open) return;
        setTab(tabs[0]!);
        setGroup(null);
        setTarget(null);
        setTerm("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const leftGroups: readonly AddGroup[] =
        tab === "target" ? (targets?.groups ?? []) : tab === "type" ? groups : [];
    // A wide dialog always shows a group; a phone shows the list until one is chosen.
    const chosen =
        leftGroups.find((each) => each.id === group) ?? (wide ? leftGroups[0] : undefined);

    const pick = (value: string, target?: string) => {
        onPick(value, target);
        onClose();
    };

    /** Everything the search matches, across every tab, at most `SEARCH_LIMIT`. */
    const found = useMemo(() => {
        if (!term.trim()) return null;
        const hits: { key: string; item: AddItem; run: () => void }[] = [];
        for (const each of groups)
            for (const item of each.items)
                if (matches(term, item.label, item.description, each.label))
                    hits.push({ key: `type:${item.value}`, item, run: () => pick(item.value) });
        for (const item of blocks ?? [])
            if (matches(term, item.label, item.description))
                hits.push({ key: `block:${item.value}`, item, run: () => pick(item.value) });
        for (const each of targets?.groups ?? [])
            for (const item of each.items)
                if (matches(term, item.label, item.description, each.label))
                    hits.push({
                        key: `target:${item.value}`,
                        item: { ...item, description: item.description ?? each.label },
                        run: () => {
                            setTab("target");
                            setGroup(each.id);
                            setTarget(item.value);
                            setTerm("");
                        }
                    });
        return hits;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [term, groups, blocks, targets]);

    /** The target whose blocks are listed, once one is chosen. */
    const chosenTarget = tab === "target" ? target : null;

    const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "ArrowDown") return;
        if (step(resultsRef.current, null, 1)) event.preventDefault();
    };
    const onListKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const by = event.key === "ArrowDown" ? 1 : -1;
        if (!step(event.currentTarget, document.activeElement, by) && by === -1)
            searchRef.current?.focus();
    };

    const rightItems = (): ReactNode => {
        if (found) {
            if (found.length === 0)
                return (
                    <li className="px-2.5 py-6 text-center text-sm text-muted-foreground">
                        {strings.noMatch(term.trim())}
                    </li>
                );
            return (
                <>
                    {found.slice(0, SEARCH_LIMIT).map((hit) => (
                        <Option key={hit.key} item={hit.item} onPick={hit.run} />
                    ))}
                    {found.length > SEARCH_LIMIT && (
                        <li className="px-2.5 py-2 text-xs text-muted-foreground">
                            {strings.more(found.length - SEARCH_LIMIT)}
                        </li>
                    )}
                </>
            );
        }
        if (tab === "blocks")
            return (blocks ?? []).map((item) => (
                <Option key={item.value} item={item} onPick={() => pick(item.value)} />
            ));
        if (tab === "target") {
            if (chosenTarget) return targetItems(chosenTarget);
            if (!chosen) return null;
            return chosen.items.map((item) => (
                <Option
                    key={item.value}
                    item={item}
                    trailing={
                        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    }
                    onPick={() => setTarget(item.value)}
                />
            ));
        }
        return (chosen?.items ?? []).map((item) => (
            <Option key={item.value} item={item} onPick={() => pick(item.value)} />
        ));
    };
    const targetItems = (target: string): ReactNode => {
        const items = targets?.itemsFor(target) ?? [];
        const named = targets?.groups
            .flatMap((each) => each.items)
            .find((item) => item.value === target);
        const heading = named && (
            <li
                className="truncate px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground"
                title={named.label}
            >
                {named.label}
            </li>
        );
        if (items.length === 0)
            return (
                <>
                    {heading}
                    <li className="px-2.5 py-6 text-center text-sm text-muted-foreground">
                        {strings.nothingForTarget}
                    </li>
                </>
            );
        return (
            <>
                {heading}
                {items.map((item) => (
                    <Option key={item.value} item={item} onPick={() => pick(item.value, target)} />
                ))}
            </>
        );
    };

    const tabLabel: Record<Tab, string> = {
        target: strings.byTarget,
        type: strings.byType,
        blocks: strings.blocks
    };
    // On a phone, the right pane replaces the left once a group (or a target) is open.
    const showLeft = !found && leftGroups.length > 0 && (wide || (!chosen && !chosenTarget));
    const showRight = wide || !showLeft;
    const canGoBack = !found && (chosenTarget !== null || (!wide && chosen !== undefined));

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent
                showClose={false}
                aria-describedby={undefined}
                aria-labelledby={titleId}
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    searchRef.current?.focus();
                }}
                className={cn(
                    "flex flex-col gap-0 overflow-hidden p-0",
                    wide
                        ? "h-[min(36rem,85vh)] max-w-3xl"
                        : "bottom-0 left-0 top-auto h-[85dvh] max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none"
                )}
            >
                <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
                    {canGoBack && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="size-7 shrink-0 p-0"
                            aria-label={strings.back}
                            title={strings.back}
                            onClick={() => (chosenTarget ? setTarget(null) : setGroup(null))}
                        >
                            <ArrowLeft className="size-3.5" />
                        </Button>
                    )}
                    <RadixDialog.Title
                        id={titleId}
                        className="min-w-0 flex-1 truncate text-sm font-medium"
                    >
                        {title}
                    </RadixDialog.Title>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="size-7 shrink-0 p-0"
                        aria-label={strings.close}
                        title={strings.close}
                        onClick={onClose}
                    >
                        <X className="size-3.5" />
                    </Button>
                </header>
                <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            ref={searchRef}
                            type="search"
                            value={term}
                            placeholder={strings.search}
                            aria-label={strings.search}
                            className="pl-8"
                            onChange={(event) => setTerm(event.target.value)}
                            onKeyDown={onSearchKey}
                        />
                    </div>
                    {!found && tabs.length > 1 && (
                        <div role="tablist" className="flex min-w-0 gap-1 overflow-x-auto">
                            {tabs.map((each) => (
                                <button
                                    key={each}
                                    type="button"
                                    role="tab"
                                    aria-selected={tab === each}
                                    onClick={() => {
                                        setTab(each);
                                        setGroup(null);
                                        setTarget(null);
                                    }}
                                    className={cn(
                                        "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted",
                                        tab === each && "bg-muted text-foreground"
                                    )}
                                >
                                    {tabLabel[each]}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                {paste && !found && (
                    <ul className="border-b border-border p-1.5">
                        <Option
                            item={{
                                value: "paste",
                                label: paste.label,
                                description: paste.description,
                                icon: <ClipboardPaste />
                            }}
                            onPick={() => {
                                paste.onPaste();
                                onClose();
                            }}
                        />
                    </ul>
                )}
                <div className="flex min-h-0 flex-1">
                    {showLeft && (
                        <ul
                            ref={groupsRef}
                            onKeyDown={onListKey}
                            className={cn(
                                "min-h-0 overflow-y-auto overscroll-contain p-1.5",
                                wide ? "w-56 shrink-0 border-r border-border" : "flex-1"
                            )}
                        >
                            {leftGroups.map((each) => (
                                <li key={each.id}>
                                    <button
                                        type="button"
                                        data-add-option=""
                                        aria-current={chosen?.id === each.id || undefined}
                                        onClick={() => {
                                            setGroup(each.id);
                                            setTarget(null);
                                        }}
                                        className={cn(
                                            "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                                            chosen?.id === each.id && "bg-muted font-medium"
                                        )}
                                    >
                                        {each.icon && (
                                            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                                                {each.icon}
                                            </span>
                                        )}
                                        <span className="min-w-0 flex-1 truncate" title={each.label}>
                                            {each.label}
                                        </span>
                                        {!wide && (
                                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {showRight && (
                        <ul
                            ref={resultsRef}
                            onKeyDown={onListKey}
                            aria-label={found ? strings.search : (chosen?.label ?? tabLabel[tab])}
                            className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
                        >
                            {rightItems()}
                        </ul>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

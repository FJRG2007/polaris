"use client";

/**
 * The kept commands, behind one button beside the console rather than a row of
 * them above it: a server run from forty commands is a wall of buttons, and the
 * one wanted is found faster by typing part of its name.
 *
 * Opening it puts the caret in the search; Enter runs the first command left, the
 * arrows walk the list, and the arrow to the right of a command (or a press on
 * its "..." ) opens what else can be done with it - edit, schedule, put it in the
 * box, duplicate it, forget it. The menu is portalled and kept on screen, so neither the card
 * nor a narrow phone can cut it off, and it floats over the console instead of
 * pushing it down.
 */

import { useMemo, useState } from "react";
import {
    BookmarkCheck,
    CalendarClock,
    ChevronDown,
    Copy,
    ListOrdered,
    MoreHorizontal,
    Trash2
} from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    MenuSearch,
    menuSearchMatches
} from "@polaris/ui";
import { useGameText } from "../game-text";
import {
    MAX_SAVED_LABEL,
    commandPreview,
    hasPauses,
    isSequence,
    keptCommandCount,
    type SavedCommand
} from "../../lib/console-commands";
import type { KeepDraft } from "./console-keep-dialog";

/** The kept commands left after typing, in the order they were kept. Matched on
 *  the name and on the command itself. */
export function filterKeptCommands(saved: readonly SavedCommand[], query: string): SavedCommand[] {
    return saved.filter((entry) => menuSearchMatches(`${entry.label} ${entry.command}`, query));
}

/** A new command to keep, written from an existing one: the same command and
 *  blanks under a name that says it is a copy, cut so the whole name still fits.
 *  It has no id, so keeping it adds one instead of rewriting the original. */
export function duplicateDraft(entry: SavedCommand, copyName: (name: string) => string): KeepDraft {
    let name = entry.label;
    let label = copyName(name);
    while (label.length > MAX_SAVED_LABEL && name.length > 0) {
        name = name.slice(0, -1).trimEnd();
        label = copyName(name);
    }
    return {
        label: label.slice(0, MAX_SAVED_LABEL),
        command: entry.command,
        variables: entry.variables ?? []
    };
}

export function KeptCommandsMenu({
    saved,
    canRun,
    canManage,
    onRun,
    onEdit,
    onSchedule,
    onLoad,
    onDuplicate,
    onForget
}: {
    saved: readonly SavedCommand[];
    /** Whether a command can be sent now: the server is up and nothing is pending. */
    canRun: boolean;
    /** Whether the list has been read, so editing one edits what is really kept. */
    canManage: boolean;
    onRun: (entry: SavedCommand) => void;
    onEdit: (entry: SavedCommand) => void;
    onSchedule: (entry: SavedCommand) => void;
    onLoad: (entry: SavedCommand) => void;
    onDuplicate: (entry: SavedCommand) => void;
    onForget: (entry: SavedCommand) => void;
}) {
    const t = useGameText("games");
    const [query, setQuery] = useState("");
    const shown = useMemo(() => filterKeptCommands(saved, query), [saved, query]);

    return (
        // An old search is not what somebody reopening the list is looking for.
        <DropdownMenu onOpenChange={(open) => (open ? setQuery("") : undefined)}>
            <DropdownMenuTrigger asChild>
                <Button size="xs" variant="outline" disabled={!canManage}>
                    <BookmarkCheck className="size-3.5" />
                    {t("console.keptCommands", { count: saved.length })}
                    <ChevronDown className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="w-[min(24rem,calc(100vw-2rem))] max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))]"
            >
                {/* Pinned above the list, so the search can be corrected after
                    scrolling through what it found. */}
                <MenuSearch
                    value={query}
                    onChange={setQuery}
                    placeholder={t("console.searchKept")}
                    onSubmit={canRun ? undefined : () => undefined}
                    className="sticky -top-1 z-10 -mx-1 -mt-1 bg-elevated px-3 pt-2"
                />
                {!canRun && (
                    <p className="px-2 pt-2 text-[0.75rem] text-muted-foreground">
                        {t("console.startTheServerToSend")}
                    </p>
                )}
                {shown.length === 0 ? (
                    <p className="px-2 py-3 text-[0.75rem] text-muted-foreground">
                        {t("console.noKeptMatch")}
                    </p>
                ) : (
                    shown.map((entry) => (
                        <div key={entry.id} className="flex min-w-0 items-stretch gap-0.5">
                            <DropdownMenuItem
                                disabled={!canRun}
                                onSelect={() => onRun(entry)}
                                title={entry.command}
                                className="min-w-0 flex-1 flex-col items-start gap-0"
                            >
                                <span className="flex w-full min-w-0 items-center gap-1.5">
                                    <span className="min-w-0 truncate">{entry.label}</span>
                                    {isSequence(entry.command) && (
                                        <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 text-[0.6875rem] text-muted-foreground">
                                            <ListOrdered className="size-3" />
                                            {t("console.keptCount", {
                                                count: keptCommandCount(entry.command)
                                            })}
                                        </span>
                                    )}
                                </span>
                                <span className="w-full truncate font-mono text-[0.6875rem] text-muted-foreground">
                                    {commandPreview(entry.command)}
                                </span>
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger
                                    aria-label={t("console.moreFor", { name: entry.label })}
                                    title={t("console.moreFor", { name: entry.label })}
                                    // The chevron the trigger draws stands in for
                                    // the dots on a screen this narrow.
                                    className="shrink-0 px-1.5 [&>svg:last-child]:hidden"
                                >
                                    <MoreHorizontal className="size-4 text-muted-foreground" />
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="w-[min(18rem,calc(100vw-2rem))]">
                                    <DropdownMenuLabel
                                        className="truncate font-mono normal-case tracking-normal"
                                        title={entry.command}
                                    >
                                        {commandPreview(entry.command)}
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onSelect={() => onEdit(entry)}>
                                        {t("console.edit")}
                                    </DropdownMenuItem>
                                    {/* The sweep runs a schedule in one go; a pause is
                                        only kept by the console. */}
                                    {hasPauses(entry.command) ? (
                                        <DropdownMenuItem
                                            disabled
                                            className="flex-col items-start gap-0"
                                        >
                                            <span className="flex items-center gap-2">
                                                <CalendarClock /> {t("consoleSchedule.scheduleIt")}
                                            </span>
                                            <span className="text-[0.6875rem] text-muted-foreground">
                                                {t("console.pausesNoSchedule")}
                                            </span>
                                        </DropdownMenuItem>
                                    ) : (
                                        <DropdownMenuItem onSelect={() => onSchedule(entry)}>
                                            <CalendarClock /> {t("consoleSchedule.scheduleIt")}
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onSelect={() => onLoad(entry)}>
                                        {t("console.putItInTheBox")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        aria-label={t("console.duplicateName", {
                                            name: entry.label
                                        })}
                                        title={t("console.duplicateName", { name: entry.label })}
                                        onSelect={() => onDuplicate(entry)}
                                    >
                                        <Copy /> {t("console.duplicateIt")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        variant="danger"
                                        onSelect={() => onForget(entry)}
                                    >
                                        <Trash2 /> {t("console.forgetIt")}
                                    </DropdownMenuItem>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        </div>
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

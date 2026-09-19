"use client";

/**
 * Send, and the other ways to send.
 *
 * The same split the microphone beside it and the call controls use: the button
 * does the thing that is done every time, and the chevron holds what is chosen
 * now and then. Sending later and putting a message aside are both "not now" -
 * they belong behind the arrow that means "now", not as two more icons in a row
 * somebody has to learn.
 *
 * With nothing behind it the chevron is not drawn at all. A task's comment box
 * has no hour to send at and no draft to keep, and a menu that opens onto nothing
 * is a control that lies.
 */

import { CalendarClock, ChevronDown, FilePen, SendHorizontal } from "lucide-react";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@polaris/ui";

export function SendButton({
    disabled,
    onSend,
    onSchedule,
    onSaveDraft,
    draftRefusal
}: {
    /** Nothing to send, or not allowed to. The same for all three: "when" and
     *  "later" are not questions about nothing. */
    disabled: boolean;
    onSend: () => void;
    /** Absent where there is no sending later. */
    onSchedule?: () => void;
    /** Absent where there is no keeping a draft. */
    onSaveDraft?: () => void;
    /** Why saving a draft is not possible right now, when it is not. Said on the
     *  item rather than hiding it, since the reason is something to fix. */
    draftRefusal?: string;
}) {
    const menu = onSchedule !== undefined || onSaveDraft !== undefined;

    return (
        <span className="flex items-center">
            <button
                type="button"
                disabled={disabled}
                onClick={onSend}
                aria-label="Send"
                title="Send"
                className={cn(
                    "rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
                    menu && "rounded-r-none pr-1"
                )}
            >
                <SendHorizontal className="size-4" />
            </button>
            {menu && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            disabled={disabled}
                            aria-label="More ways to send"
                            title="More ways to send"
                            className="rounded rounded-l-none py-1.5 pl-0.5 pr-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                        >
                            <ChevronDown className="size-3" />
                        </button>
                    </DropdownMenuTrigger>
                    {/* Upward and to the right edge: the box is at the bottom of
                        the screen and the button at the end of it. */}
                    <DropdownMenuContent align="end" side="top" className="w-56">
                        {onSchedule && (
                            <DropdownMenuItem onSelect={onSchedule}>
                                <CalendarClock />
                                Schedule message
                            </DropdownMenuItem>
                        )}
                        {onSaveDraft && (
                            <DropdownMenuItem
                                disabled={draftRefusal !== undefined}
                                onSelect={onSaveDraft}
                                className="items-start"
                            >
                                <FilePen className="mt-0.5" />
                                <span className="flex flex-col">
                                    Save as draft
                                    {draftRefusal && (
                                        <span className="text-[0.6875rem] text-muted-foreground">
                                            {draftRefusal}
                                        </span>
                                    )}
                                </span>
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </span>
    );
}

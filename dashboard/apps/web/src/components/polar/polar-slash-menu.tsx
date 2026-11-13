"use client";

/**
 * The "/" list over a Polar composer, Chat's and Code's alike. Drawn in a
 * portal above the composer, flipping below or shrinking when there is no room,
 * so a panel that clips its overflow never cuts it. The keys stay with the
 * composer: focus never leaves the box while the list is open.
 */

import { useRef } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@polaris/ui";
import { SuggestionList, type SuggestionListItem } from "@/components/rich-text/suggestion-list";

export function PolarSlashMenu({
    open,
    id,
    label,
    items,
    active,
    onHover,
    onPick,
    onDismiss
}: {
    open: boolean;
    id: string;
    label: string;
    items: readonly SuggestionListItem[];
    active: number;
    onHover: (index: number) => void;
    onPick: (index: number) => void;
    /** A press outside the composer closes the list. */
    onDismiss: () => void;
}) {
    // A zero-height mark along the composer's top edge: the list lines up with
    // the composer's left edge and takes its width, up to the list's own.
    const anchor = useRef<HTMLDivElement>(null);
    return (
        <Popover open={open}>
            <PopoverAnchor asChild>
                <div ref={anchor} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0" />
            </PopoverAnchor>
            {open ? (
                <PopoverContent
                    side="top"
                    align="start"
                    className="w-[min(24rem,var(--radix-popper-anchor-width),calc(100vw-1rem))] overflow-visible border-0 bg-transparent p-0 shadow-none"
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onCloseAutoFocus={(event) => event.preventDefault()}
                    // Escape is the composer's: it closes the list for the
                    // token it was open on, and nothing else.
                    onEscapeKeyDown={(event) => event.preventDefault()}
                    onInteractOutside={(event) => {
                        const composer = anchor.current?.parentElement;
                        if (composer && event.target instanceof Node && composer.contains(event.target)) {
                            event.preventDefault();
                            return;
                        }
                        onDismiss();
                    }}
                >
                    <SuggestionList
                        id={id}
                        label={label}
                        items={items}
                        active={active}
                        onHover={onHover}
                        onPick={onPick}
                        className="max-h-[min(16rem,var(--radix-popover-content-available-height))] w-full"
                    />
                </PopoverContent>
            ) : null}
        </Popover>
    );
}

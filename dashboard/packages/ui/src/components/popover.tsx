"use client";

/**
 * A floating panel tied to an anchor: the design system's popover surface,
 * portaled above the dialog layer, flipping and shifting to stay on screen and
 * scrolling inside when the window is short.
 */

import * as RadixPopover from "@radix-ui/react-popover";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "../lib/cn";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverAnchor = RadixPopover.Anchor;
export const PopoverClose = RadixPopover.Close;

export const PopoverContent = forwardRef<
    ElementRef<typeof RadixPopover.Content>,
    ComponentPropsWithoutRef<typeof RadixPopover.Content>
>(({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) => (
    <RadixPopover.Portal>
        <RadixPopover.Content
            ref={ref}
            sideOffset={sideOffset}
            collisionPadding={collisionPadding}
            className={cn(
                "z-50 max-h-[--radix-popover-content-available-height] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-lg border border-border-strong bg-elevated p-3 text-foreground shadow-popover",
                className
            )}
            {...props}
        />
    </RadixPopover.Portal>
));
PopoverContent.displayName = "PopoverContent";

"use client";

/**
 * Right-click context menu built on Radix. Mirrors the dropdown-menu styling so
 * row actions look the same whether reached by a trigger button or a right-click.
 * The file browser uses it for per-entry actions (open, rename, share, delete).
 */

import { cn } from "../lib/cn";
import { ChevronRight } from "lucide-react";
import { useSettledHover } from "../lib/menu-hover";
import { ignoreOpeningPress } from "../lib/menu-press";
import { keepSearchFocus, redirectMenuFocus } from "../lib/menu-search-focus";
import * as RadixMenu from "@radix-ui/react-context-menu";
import { forwardRef, useMemo, useState, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { MenuSurfaceProvider, useMenuSurface } from "../lib/menu-surface";

export const ContextMenu = RadixMenu.Root;
export const ContextMenuTrigger = RadixMenu.Trigger;
export const ContextMenuGroup = RadixMenu.Group;

/**
 * A submenu that is built once and then kept.
 *
 * A menu drops a submenu's contents the instant the pointer leaves it, so
 * stepping along a row of them - status, then priority, then people - builds
 * each list from scratch every single time, including on the way back to one
 * that was open a second ago. On a list of any size that reads as the menu
 * stopping to load something, when there was nothing to load.
 *
 * So the first time one opens it stays mounted and is hidden while closed:
 * coming back to it is a class change rather than a rebuild. It lasts as long as
 * the menu is open, which is the span somebody is moving between the options.
 */
export function ContextMenuSub({ onOpenChange, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Sub>) {
    const [open, setOpen] = useState(false);
    const [kept, setKept] = useState(false);
    // Published rather than kept to this file: something drawn inside a submenu
    // that is hidden instead of unmounted has no other way of telling that it
    // is back on screen - see `menu-surface`.
    const surface = useMemo(() => ({ open, kept }), [open, kept]);
    return (
        <MenuSurfaceProvider value={surface}>
            <RadixMenu.Sub
                {...props}
                onOpenChange={(next) => {
                    setOpen(next);
                    // Kept only once it has actually been opened, so a menu
                    // nobody steps into still costs nothing to put on screen.
                    if (next) setKept(true);
                    onOpenChange?.(next);
                }}
            />
        </MenuSurfaceProvider>
    );
}

export const ContextMenuContent = forwardRef<
    ElementRef<typeof RadixMenu.Content>,
    ComponentPropsWithoutRef<typeof RadixMenu.Content>
>(({ className, onFocus, ...props }, ref) => (
    <RadixMenu.Portal>
        <RadixMenu.Content
            ref={ref}
            className={cn(
                "z-50 min-w-[11rem] overflow-hidden rounded-lg border border-border-strong bg-elevated p-1 text-foreground shadow-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                className
            )}
            {...props}
            // A menu with a field at the top of it hands that field the focus
            // the surface was given - see `redirectMenuFocus`. On the surface's
            // own focus rather than on the way open, because the menu focuses
            // itself and this has to be the answer to that rather than a race
            // with it.
            onFocus={(event) => {
                onFocus?.(event);
                redirectMenuFocus(event);
            }}
            // After the spread: the menu must never commit an option on the
            // release of the press that opened it.
            onPointerUpCapture={ignoreOpeningPress}
            // And once it has it, the pointer does not take it back off it -
            // see `keepSearchFocus`.
            onPointerMoveCapture={keepSearchFocus}
        />
    </RadixMenu.Portal>
));
ContextMenuContent.displayName = "ContextMenuContent";

export const ContextMenuItem = forwardRef<
    ElementRef<typeof RadixMenu.Item>,
    ComponentPropsWithoutRef<typeof RadixMenu.Item> & { variant?: "default" | "danger" }
>(({ className, variant = "default", ...props }, ref) => (
    <RadixMenu.Item
        ref={ref}
        className={cn(
            "relative flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[0.8125rem] outline-none transition-colors duration-fast focus:bg-card-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
            variant === "danger" && "text-danger focus:bg-danger/10",
            className
        )}
        {...props}
    />
));
ContextMenuItem.displayName = "ContextMenuItem";

export const ContextMenuSubTrigger = forwardRef<
    ElementRef<typeof RadixMenu.SubTrigger>,
    ComponentPropsWithoutRef<typeof RadixMenu.SubTrigger> & { variant?: "default" | "danger" }
>(({ className, children, variant = "default", onPointerMove, onPointerLeave, ...props }, ref) => {
    const settled = useSettledHover();

    return (
        <RadixMenu.SubTrigger
            ref={ref}
            className={cn(
                "relative flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[0.8125rem] outline-none transition-colors duration-fast focus:bg-card-hover data-[state=open]:bg-card-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                // A submenu whose options all do the same heavy thing is that
                // thing, and the trigger is the only part of it anybody reads
                // before deciding. Same red as an item, for the same reason.
                variant === "danger" && "text-danger focus:bg-danger/10 data-[state=open]:bg-danger/10",
                className
            )}
            {...props}
            // After the spread, so nothing a caller passes loses the nudge.
            onPointerMove={(event) => {
                onPointerMove?.(event);
                settled.onPointerMove(event);
            }}
            onPointerLeave={(event) => {
                onPointerLeave?.(event);
                settled.onPointerLeave();
            }}
        >
            {children}
            <ChevronRight className="ml-auto size-4" />
        </RadixMenu.SubTrigger>
    );
});
ContextMenuSubTrigger.displayName = "ContextMenuSubTrigger";

export const ContextMenuSubContent = forwardRef<
    ElementRef<typeof RadixMenu.SubContent>,
    ComponentPropsWithoutRef<typeof RadixMenu.SubContent>
>(({ className, ...props }, ref) => {
    // Kept mounted once it has been opened - see ContextMenuSub. Hidden rather
    // than faded while closed, since there is nothing to animate out of a
    // submenu that is only being stepped past.
    const { kept } = useMenuSurface();
    return (
        <RadixMenu.Portal forceMount={kept || undefined}>
            <RadixMenu.SubContent
                ref={ref}
                forceMount={kept || undefined}
                className={cn(
                    "z-50 min-w-[11rem] overflow-hidden rounded-lg border border-border-strong bg-elevated p-1 text-foreground shadow-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                    className,
                    kept && "data-[state=closed]:hidden"
                )}
                {...props}
                // After the spread: the menu must never commit an option on the
                // release of the press that opened it.
                onPointerUpCapture={ignoreOpeningPress}
            // And once it has it, the pointer does not take it back off it -
            // see `keepSearchFocus`.
            onPointerMoveCapture={keepSearchFocus}
            />
        </RadixMenu.Portal>
    );
});
ContextMenuSubContent.displayName = "ContextMenuSubContent";

export function ContextMenuSeparator({ className }: { className?: string }) {
    return <RadixMenu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

export function ContextMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Label>) {
    return (
        <RadixMenu.Label
            className={cn("truncate px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
            {...props}
        />
    );
}

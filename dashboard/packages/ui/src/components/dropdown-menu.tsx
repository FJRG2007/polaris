"use client";

/** Dropdown menu built on Radix. Used by the app switcher and row actions. */

import { cn } from "../lib/cn";
import { ChevronRight } from "lucide-react";
import { useSettledHover } from "../lib/menu-hover";
import { ignoreOpeningPress } from "../lib/menu-press";
import { keepSearchFocus, redirectMenuFocus } from "../lib/menu-search-focus";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

/** How far a menu keeps from the edge of the screen, in px - the page's own
 *  gutter on a phone. */
export const MENU_GUTTER = 16;

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;
export const DropdownMenuGroup = RadixMenu.Group;
export const DropdownMenuSub = RadixMenu.Sub;
export const DropdownMenuSeparatorRoot = RadixMenu.Separator;

export const DropdownMenuContent = forwardRef<
    ElementRef<typeof RadixMenu.Content>,
    ComponentPropsWithoutRef<typeof RadixMenu.Content>
>(({ className, sideOffset = 6, collisionPadding = MENU_GUTTER, onFocus, ...props }, ref) => (
    <RadixMenu.Portal>
        <RadixMenu.Content
            ref={ref}
            sideOffset={sideOffset}
            // Kept off the screen's edge, and never taller or wider than what is
            // left of it: the app switcher lists every app with a line of
            // description under each, which is taller than a phone, and a surface
            // that clipped its overflow left the bottom half of it unreachable.
            collisionPadding={collisionPadding}
            className={cn(
                "z-50 max-h-[--radix-dropdown-menu-content-available-height] min-w-[min(12rem,calc(100vw-2rem))] max-w-[--radix-dropdown-menu-content-available-width] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-border-strong bg-elevated p-1 text-foreground shadow-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
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
DropdownMenuContent.displayName = "DropdownMenuContent";

/**
 * One option.
 *
 * `variant="danger"` is how an option that destroys something is drawn, and it
 * is the same red in the context menu, so the item that deletes a thing looks
 * the same whether it was reached by a right-click or by a trigger button. It
 * belongs to the primitive rather than to each caller's `className`: a colour
 * every screen restates is a colour that ends up slightly different on half of
 * them, and this one is a warning.
 */
export const DropdownMenuItem = forwardRef<
    ElementRef<typeof RadixMenu.Item>,
    ComponentPropsWithoutRef<typeof RadixMenu.Item> & {
        disabled?: boolean;
        variant?: "default" | "danger";
    }
>(({ className, variant = "default", ...props }, ref) => (
    <RadixMenu.Item
        ref={ref}
        className={cn(
            "relative flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[0.8125rem] outline-none transition-colors duration-fast focus:bg-card-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
            variant === "danger" && "text-danger focus:bg-danger-soft focus:text-danger",
            className
        )}
        {...props}
    />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

/** A submenu's trigger. Same shape and same nudge as the right-click menu's:
 *  they are the same submenus reached two ways. */
export const DropdownMenuSubTrigger = forwardRef<
    ElementRef<typeof RadixMenu.SubTrigger>,
    ComponentPropsWithoutRef<typeof RadixMenu.SubTrigger> & { variant?: "default" | "danger" }
>(({ className, children, variant = "default", onPointerMove, onPointerLeave, ...props }, ref) => {
    const settled = useSettledHover();
    return (
        <RadixMenu.SubTrigger
            ref={ref}
            className={cn(
                "relative flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[0.8125rem] outline-none transition-colors duration-fast focus:bg-card-hover data-[state=open]:bg-card-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
                // A submenu whose options all do the same heavy thing is that
                // thing, and the trigger is the only part of it anybody reads
                // before deciding. Same red as an item, for the same reason.
                variant === "danger" && "text-danger focus:bg-danger-soft data-[state=open]:bg-danger-soft",
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
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = forwardRef<
    ElementRef<typeof RadixMenu.SubContent>,
    ComponentPropsWithoutRef<typeof RadixMenu.SubContent>
>(({ className, collisionPadding = MENU_GUTTER, ...props }, ref) => (
    <RadixMenu.Portal>
        <RadixMenu.SubContent
            ref={ref}
            collisionPadding={collisionPadding}
            className={cn(
                "z-50 max-h-[--radix-dropdown-menu-content-available-height] min-w-[min(12rem,calc(100vw-2rem))] max-w-[--radix-dropdown-menu-content-available-width] overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-border-strong bg-elevated p-1 text-foreground shadow-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                className
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
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";

export function DropdownMenuSeparator({ className }: { className?: string }) {
    return <RadixMenu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Label>) {
    return (
        <RadixMenu.Label
            className={cn(
                "px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle",
                className
            )}
            {...props}
        />
    );
}

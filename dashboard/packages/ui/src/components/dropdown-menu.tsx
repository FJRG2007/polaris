"use client";

/** Dropdown menu built on Radix. Used by the app switcher and row actions. */

import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "../lib/cn.js";

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;
export const DropdownMenuGroup = RadixMenu.Group;
export const DropdownMenuSeparatorRoot = RadixMenu.Separator;

export const DropdownMenuContent = forwardRef<
    ElementRef<typeof RadixMenu.Content>,
    ComponentPropsWithoutRef<typeof RadixMenu.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
    <RadixMenu.Portal>
        <RadixMenu.Content
            ref={ref}
            sideOffset={sideOffset}
            className={cn(
                "z-50 min-w-[12rem] overflow-hidden rounded-md border border-border bg-card p-1 text-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                className
            )}
            {...props}
        />
    </RadixMenu.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<
    ElementRef<typeof RadixMenu.Item>,
    ComponentPropsWithoutRef<typeof RadixMenu.Item> & { disabled?: boolean }
>(({ className, ...props }, ref) => (
    <RadixMenu.Item
        ref={ref}
        className={cn(
            "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
            className
        )}
        {...props}
    />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuSeparator({ className }: { className?: string }) {
    return <RadixMenu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Label>) {
    return (
        <RadixMenu.Label
            className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
            {...props}
        />
    );
}

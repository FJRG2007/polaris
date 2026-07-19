"use client";

/**
 * Right-click context menu built on Radix. Mirrors the dropdown-menu styling so
 * row actions look the same whether reached by a trigger button or a right-click.
 * The file browser uses it for per-entry actions (open, rename, share, delete).
 */

import * as RadixMenu from "@radix-ui/react-context-menu";
import { ChevronRight } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "../lib/cn.js";

export const ContextMenu = RadixMenu.Root;
export const ContextMenuTrigger = RadixMenu.Trigger;
export const ContextMenuGroup = RadixMenu.Group;
export const ContextMenuSub = RadixMenu.Sub;

export const ContextMenuContent = forwardRef<
    ElementRef<typeof RadixMenu.Content>,
    ComponentPropsWithoutRef<typeof RadixMenu.Content>
>(({ className, ...props }, ref) => (
    <RadixMenu.Portal>
        <RadixMenu.Content
            ref={ref}
            className={cn(
                "z-50 min-w-[11rem] overflow-hidden rounded-md border border-border bg-card p-1 text-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                className
            )}
            {...props}
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
            "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
            variant === "danger" && "text-danger focus:bg-danger/10",
            className
        )}
        {...props}
    />
));
ContextMenuItem.displayName = "ContextMenuItem";

export const ContextMenuSubTrigger = forwardRef<
    ElementRef<typeof RadixMenu.SubTrigger>,
    ComponentPropsWithoutRef<typeof RadixMenu.SubTrigger>
>(({ className, children, ...props }, ref) => (
    <RadixMenu.SubTrigger
        ref={ref}
        className={cn(
            "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-muted data-[state=open]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
            className
        )}
        {...props}
    >
        {children}
        <ChevronRight className="ml-auto size-4" />
    </RadixMenu.SubTrigger>
));
ContextMenuSubTrigger.displayName = "ContextMenuSubTrigger";

export const ContextMenuSubContent = forwardRef<
    ElementRef<typeof RadixMenu.SubContent>,
    ComponentPropsWithoutRef<typeof RadixMenu.SubContent>
>(({ className, ...props }, ref) => (
    <RadixMenu.Portal>
        <RadixMenu.SubContent
            ref={ref}
            className={cn(
                "z-50 min-w-[11rem] overflow-hidden rounded-md border border-border bg-card p-1 text-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                className
            )}
            {...props}
        />
    </RadixMenu.Portal>
));
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

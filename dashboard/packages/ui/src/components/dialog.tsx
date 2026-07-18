"use client";

/** Modal dialog built on Radix, used for connection/share/request forms. */

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "../lib/cn.js";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export const DialogContent = forwardRef<
    ElementRef<typeof RadixDialog.Content>,
    ComponentPropsWithoutRef<typeof RadixDialog.Content>
>(({ className, children, ...props }, ref) => (
    <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <RadixDialog.Content
            ref={ref}
            className={cn(
                "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-xl focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
                className
            )}
            {...props}
        >
            {children}
            <RadixDialog.Close className="absolute right-4 top-4 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none">
                <X className="size-4" />
                <span className="sr-only">Close</span>
            </RadixDialog.Close>
        </RadixDialog.Content>
    </RadixDialog.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
    return <div className={cn("mb-4 flex flex-col gap-1", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentPropsWithoutRef<typeof RadixDialog.Title>) {
    return <RadixDialog.Title className={cn("text-base font-semibold", className)} {...props} />;
}

export function DialogDescription({
    className,
    ...props
}: ComponentPropsWithoutRef<typeof RadixDialog.Description>) {
    return (
        <RadixDialog.Description
            className={cn("text-sm text-muted-foreground", className)}
            {...props}
        />
    );
}

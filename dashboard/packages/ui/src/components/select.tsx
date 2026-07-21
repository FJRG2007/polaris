"use client";

/**
 * Select primitive built on Radix. Replaces the raw <select>/<option> elements
 * scattered across the dashboard with a styled, keyboard-accessible listbox that
 * matches the design system (typeahead, arrow-key navigation, ARIA semantics).
 *
 * Two ways to use it:
 *  - Ergonomic form: <Select value onValueChange options placeholder /> - covers
 *    almost every call site, where the options are a flat list of value/label
 *    (with an optional per-option icon).
 *  - Composable form: the exported Radix parts (SelectRoot, SelectTrigger,
 *    SelectContent, SelectItem, ...) for the rare case that needs groups or
 *    custom item markup.
 *
 * Radix forbids an empty-string item value, so a "nothing selected" state is
 * expressed with `value=""` plus a `placeholder` rather than a blank option.
 */

import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { cn } from "../lib/cn.js";

export const SelectRoot = RadixSelect.Root;
export const SelectGroup = RadixSelect.Group;
export const SelectValue = RadixSelect.Value;

export const SelectTrigger = forwardRef<
    ElementRef<typeof RadixSelect.Trigger>,
    ComponentPropsWithoutRef<typeof RadixSelect.Trigger>
>(({ className, children, ...props }, ref) => (
    <RadixSelect.Trigger
        ref={ref}
        className={cn(
            "group flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-surface px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground hover:border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:line-clamp-1 [&>span]:flex [&>span]:items-center [&>span]:gap-2",
            className
        )}
        {...props}
    >
        {children}
        <RadixSelect.Icon asChild>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </RadixSelect.Icon>
    </RadixSelect.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

export const SelectContent = forwardRef<
    ElementRef<typeof RadixSelect.Content>,
    ComponentPropsWithoutRef<typeof RadixSelect.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
    <RadixSelect.Portal>
        <RadixSelect.Content
            ref={ref}
            position={position}
            sideOffset={position === "popper" ? 6 : undefined}
            className={cn(
                "relative z-50 max-h-[--radix-select-content-available-height] min-w-[8rem] overflow-hidden rounded-md border border-border bg-card text-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
                position === "popper" && "w-[--radix-select-trigger-width]",
                className
            )}
            {...props}
        >
            <RadixSelect.Viewport className="max-h-72 overflow-y-auto p-1">
                {children}
            </RadixSelect.Viewport>
        </RadixSelect.Content>
    </RadixSelect.Portal>
));
SelectContent.displayName = "SelectContent";

export const SelectLabel = forwardRef<
    ElementRef<typeof RadixSelect.Label>,
    ComponentPropsWithoutRef<typeof RadixSelect.Label>
>(({ className, ...props }, ref) => (
    <RadixSelect.Label
        ref={ref}
        className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
        {...props}
    />
));
SelectLabel.displayName = "SelectLabel";

export const SelectItem = forwardRef<
    ElementRef<typeof RadixSelect.Item>,
    ComponentPropsWithoutRef<typeof RadixSelect.Item> & { icon?: ReactNode }
>(({ className, children, icon, ...props }, ref) => (
    <RadixSelect.Item
        ref={ref}
        className={cn(
            "relative flex w-full cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none transition-colors focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[state=checked]:text-foreground",
            className
        )}
        {...props}
    >
        {/* Icon as a flex sibling so it sits beside the label, never stacked above it. */}
        {icon != null && <span className="flex shrink-0 items-center">{icon}</span>}
        <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
        <RadixSelect.ItemIndicator className="absolute right-2 flex items-center">
            <Check className="size-4 text-primary" />
        </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
));
SelectItem.displayName = "SelectItem";

export const SelectSeparator = forwardRef<
    ElementRef<typeof RadixSelect.Separator>,
    ComponentPropsWithoutRef<typeof RadixSelect.Separator>
>(({ className, ...props }, ref) => (
    <RadixSelect.Separator
        ref={ref}
        className={cn("-mx-1 my-1 h-px bg-border", className)}
        {...props}
    />
));
SelectSeparator.displayName = "SelectSeparator";

export interface SelectOption {
    value: string;
    label: ReactNode;
    icon?: ReactNode;
    disabled?: boolean;
}

export interface SelectProps {
    value: string;
    onValueChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    /** Class for the trigger. */
    className?: string;
    /** Class for the dropdown content. */
    contentClassName?: string;
    id?: string;
    name?: string;
    "aria-label"?: string;
}

/**
 * Ergonomic Select: pass a flat `options` list and get a fully styled dropdown.
 * The selected option's icon is mirrored in the trigger so the closed state reads
 * the same as the open one.
 */
export function Select({
    value,
    onValueChange,
    options,
    placeholder,
    disabled,
    className,
    contentClassName,
    id,
    name,
    "aria-label": ariaLabel
}: SelectProps) {
    const selected = options.find((option) => option.value === value);

    return (
        <RadixSelect.Root
            value={value}
            onValueChange={onValueChange}
            disabled={disabled}
            name={name}
        >
            <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
                <RadixSelect.Value placeholder={placeholder}>
                    {selected && (
                        <>
                            {selected.icon}
                            {selected.label}
                        </>
                    )}
                </RadixSelect.Value>
            </SelectTrigger>
            <SelectContent className={contentClassName}>
                {options.map((option) => (
                    <SelectItem key={option.value} value={option.value} disabled={option.disabled} icon={option.icon}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </RadixSelect.Root>
    );
}

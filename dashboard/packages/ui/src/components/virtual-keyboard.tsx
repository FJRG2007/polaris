"use client";

/**
 * An on-screen keyboard for a script the reader's own keyboard does not
 * type, the way Google Input Tools offers one: a button beside a field opens
 * the keys of a layout (accented Latin, Cyrillic, Greek, Arabic, Hebrew,
 * Devanagari, kana, Hangul), with a Shift and an Alt layer, and each key
 * types at the field's caret as a real key would - React's onChange fires.
 * Korean jamo compose into syllables as they are typed.
 *
 * The keys never take focus from the field when clicked, so the caret stays
 * where the reader put it; they are still buttons, reachable with Tab and
 * pressed with Enter or Space. The panel sits in a portal and moves to stay
 * on screen, from a phone to a wide window.
 */

import { cn } from "../lib/cn";
import { Button } from "./button";
import { Select } from "./select";
import * as Popover from "@radix-ui/react-popover";
import { Delete, Keyboard, X } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import {
    KEYBOARD_LAYOUTS,
    LAYOUTS,
    backspaceHangul,
    composeHangul,
    deleteBefore,
    insertAt,
    isJamo,
    type KeyboardLayoutId,
    type TextField
} from "../lib/keyboard-layouts";

export interface VirtualKeyboardLabels {
    open: string;
    close: string;
    shift: string;
    alt: string;
    backspace: string;
    space: string;
    layout: string;
    /** Each layout's name in the screen's language. */
    layouts: Record<KeyboardLayoutId, string>;
}

export interface VirtualKeyboardProps {
    /** The field the keys type into. */
    target: RefObject<TextField | null>;
    layout: KeyboardLayoutId;
    onLayoutChange: (layout: KeyboardLayoutId) => void;
    labels: VirtualKeyboardLabels;
    disabled?: boolean;
    /** Class for the button that opens it. */
    className?: string;
}

/** A combining mark shown on a dotted circle, so the key is not blank. */
const shown = (key: string) => (/^\p{M}/u.test(key) ? `◌${key}` : key);

export function VirtualKeyboard({
    target,
    layout,
    onLayoutChange,
    labels,
    disabled,
    className
}: VirtualKeyboardProps) {
    const [open, setOpen] = useState(false);
    const [shift, setShift] = useState(false);
    const [alt, setAlt] = useState(false);
    // Where the last Hangul key left the caret: only there does the next one compose.
    const composing = useRef<number | null>(null);

    const field = () => target.current;
    const keys = LAYOUTS[layout];
    const layer = alt ? keys.alt : shift ? keys.shift : keys.base;

    const caretStill = (input: TextField) =>
        composing.current !== null &&
        input.selectionStart === composing.current &&
        input.selectionEnd === composing.current;

    const press = (key: string) => {
        const input = field();
        if (!input) return;
        if (layout === "hangul" && isJamo(key) && caretStill(input) && input.selectionStart! > 0) {
            const before = input.value.slice(input.selectionStart! - 1, input.selectionStart!);
            composing.current = insertAt(input, composeHangul(before, key), 1);
        } else {
            const caret = insertAt(input, key);
            composing.current = layout === "hangul" && isJamo(key) ? caret : null;
        }
        // Shift is for one key, as on a phone; Alt stays until turned off.
        if (shift && !alt) setShift(false);
    };

    const backspace = () => {
        const input = field();
        if (!input) return;
        if (layout === "hangul" && caretStill(input) && input.selectionStart! > 0) {
            const at = input.selectionStart!;
            const rest = backspaceHangul(input.value.slice(at - 1, at));
            composing.current = insertAt(input, rest, 1);
            if (!rest) composing.current = null;
            return;
        }
        composing.current = null;
        deleteBefore(input);
    };

    const space = () => {
        const input = field();
        if (!input) return;
        composing.current = null;
        insertAt(input, " ");
    };

    // A click keeps the field focused; Tab and Enter still reach every key.
    const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();
    const keyClass =
        "flex h-11 min-w-0 flex-1 items-center justify-center rounded-md border border-border bg-surface px-0.5 text-base text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted";

    return (
        <Popover.Root
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                composing.current = null;
            }}
        >
            <Popover.Trigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className={className}
                    disabled={disabled}
                    aria-label={open ? labels.close : labels.open}
                    title={open ? labels.close : labels.open}
                    aria-pressed={open}
                >
                    <Keyboard className="size-4 shrink-0" aria-hidden />
                </Button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="bottom"
                    align="end"
                    sideOffset={6}
                    collisionPadding={8}
                    // The field keeps the focus and its caret.
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onInteractOutside={(event) => {
                        // Clicking into the field to move the caret keeps the keys open.
                        if (field()?.contains(event.target as Node)) event.preventDefault();
                    }}
                    aria-label={labels.layouts[layout]}
                    role="dialog"
                    className="z-50 max-h-[--radix-popover-content-available-height] w-[min(40rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain rounded-lg border border-border-strong bg-elevated p-2 text-foreground shadow-popover"
                >
                    <div className="mb-2 flex min-w-0 items-center gap-2">
                        <Select
                            className="min-w-0 flex-1 sm:max-w-56"
                            aria-label={labels.layout}
                            value={layout}
                            onValueChange={(next) => {
                                composing.current = null;
                                setShift(false);
                                setAlt(false);
                                onLayoutChange(next as KeyboardLayoutId);
                            }}
                            options={KEYBOARD_LAYOUTS.map((id) => ({
                                value: id,
                                label: labels.layouts[id]
                            }))}
                        />
                        <Popover.Close asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="ml-auto"
                                aria-label={labels.close}
                                title={labels.close}
                            >
                                <X className="size-4 shrink-0" aria-hidden />
                            </Button>
                        </Popover.Close>
                    </div>
                    <div className="flex flex-col gap-1" dir="ltr">
                        {layer.map((row, index) => (
                            <div key={`${layout}-${index}`} className="flex min-w-0 gap-1">
                                {row.map((key, column) => (
                                    <button
                                        key={column}
                                        type="button"
                                        className={keyClass}
                                        onMouseDown={keepFocus}
                                        onClick={() => press(key)}
                                        aria-label={key}
                                    >
                                        <span className="truncate">{shown(key)}</span>
                                    </button>
                                ))}
                            </div>
                        ))}
                        <div className="flex min-w-0 gap-1">
                            <button
                                type="button"
                                className={cn(keyClass, "flex-[1.5] text-sm", shift && "bg-muted")}
                                aria-pressed={shift}
                                onMouseDown={keepFocus}
                                onClick={() => setShift(!shift)}
                            >
                                {labels.shift}
                            </button>
                            <button
                                type="button"
                                className={cn(keyClass, "flex-[1.5] text-sm", alt && "bg-muted")}
                                aria-pressed={alt}
                                onMouseDown={keepFocus}
                                onClick={() => setAlt(!alt)}
                            >
                                {labels.alt}
                            </button>
                            <button
                                type="button"
                                className={cn(keyClass, "flex-[4] text-sm")}
                                onMouseDown={keepFocus}
                                onClick={space}
                            >
                                {labels.space}
                            </button>
                            <button
                                type="button"
                                className={cn(keyClass, "flex-[1.5]")}
                                aria-label={labels.backspace}
                                title={labels.backspace}
                                onMouseDown={keepFocus}
                                onClick={backspace}
                            >
                                <Delete className="size-4 shrink-0" aria-hidden />
                            </button>
                        </div>
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

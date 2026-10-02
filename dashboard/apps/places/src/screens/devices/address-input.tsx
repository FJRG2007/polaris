"use client";

/**
 * Where a device is: an IP address or a name, or its MAC instead.
 *
 * Two ways of answering, chosen with a switch above the box rather than guessed
 * from what is typed: `cafe` is a name and `cafe12` could be the start of a MAC,
 * `192.168.1.30` is all hex digits and dots, and an IPv6 address has colons. A
 * box that reformatted itself the moment it thought it saw a MAC would be wrong
 * for somebody in every one of those cases.
 *
 * In MAC mode it is ONE box that keeps itself formatted as `AA:BB:CC:DD:EE:FF`,
 * the way a router's own page does, rather than six boxes that move the caret
 * from one to the next. Six boxes break the things people actually do with a
 * MAC: pasting one copied from an app (in any of four spellings), selecting it
 * to copy it out again, deleting a run of it, a password manager or a screen
 * reader treating it as one value. One box does all of those natively; what it
 * needs is the caret kept in the right place while colons appear and disappear,
 * which `formatMacInput`, `macBackspace` and `macDelete` (@polaris/core) do and
 * which is tested there.
 *
 * Pasting a MAC in IP mode switches to MAC mode: nobody pastes twelve hex digits
 * with colons meaning a host name.
 */

import { Input, SegmentedControl } from "@polaris/ui";
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import {
    formatMacInput,
    macBackspace,
    macDelete,
    macInText,
    parseMac,
    type MacEdit
} from "@polaris/core";
import { usePlacesT } from "../use-places-t";

export type AddressMode = "ip" | "mac";

export function AddressInput({
    value,
    onChange,
    mode,
    onModeChange,
    label,
    placeholder,
    onFocusChange
}: {
    value: string;
    onChange: (value: string) => void;
    mode: AddressMode;
    onModeChange: (mode: AddressMode) => void;
    label: string;
    placeholder?: string;
    /** Whether the box has focus, so a half-typed MAC is not called wrong
     *  while somebody is still typing it. */
    onFocusChange?: (focused: boolean) => void;
}) {
    const t = usePlacesT();
    const box = useRef<HTMLInputElement>(null);
    /** Where the caret has to go once React has written the formatted value. */
    const caret = useRef<number | null>(null);
    const [, rerender] = useState(0);

    useLayoutEffect(() => {
        if (caret.current === null || !box.current) return;
        box.current.setSelectionRange(caret.current, caret.current);
        caret.current = null;
    });

    const apply = (edit: MacEdit) => {
        caret.current = edit.caret;
        if (edit.value === value) rerender((count) => count + 1);
        else onChange(edit.value);
    };

    const switchTo = (next: AddressMode) => {
        if (next === mode) return;
        onModeChange(next);
        // What was typed for the other mode is kept only where it means the
        // same thing in this one.
        if (next === "mac") onChange(parseMac(value) ?? "");
        else onChange("");
        box.current?.focus();
    };

    const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
        const text = event.clipboardData.getData("text");
        const pasted = macInText(text);
        if (mode === "ip") {
            // A whole MAC pasted into the IP box is a MAC.
            if (pasted && parseMac(text.trim())) {
                event.preventDefault();
                onModeChange("mac");
                apply({ value: pasted, caret: pasted.length });
            }
            return;
        }
        if (!pasted) return; // Left to the browser, then to formatting.
        event.preventDefault();
        apply({ value: pasted, caret: pasted.length });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (mode !== "mac") return;
        const input = event.currentTarget;
        const start = input.selectionStart ?? 0;
        if (start !== (input.selectionEnd ?? 0)) return;
        const edit =
            event.key === "Backspace"
                ? macBackspace(value, start)
                : event.key === "Delete"
                  ? macDelete(value, start)
                  : null;
        if (!edit) return;
        event.preventDefault();
        apply(edit);
    };

    const digits = value.replace(/[^0-9a-f]/gi, "").length;

    return (
        <div className="flex flex-col gap-1.5">
            <SegmentedControl<AddressMode>
                size="sm"
                className="self-start"
                value={mode}
                onValueChange={switchTo}
                aria-label={t("connect.address.mode")}
                options={[
                    { value: "ip", label: t("connect.address.byIp") },
                    { value: "mac", label: t("connect.address.byMac") }
                ]}
            />
            <div className="relative">
                <Input
                    ref={box}
                    type="text"
                    value={value}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize={mode === "mac" ? "characters" : "off"}
                    inputMode={mode === "mac" ? "text" : "url"}
                    placeholder={mode === "mac" ? "AA:BB:CC:DD:EE:FF" : placeholder}
                    maxLength={mode === "mac" ? 17 : undefined}
                    className={mode === "mac" ? "pr-24 font-mono uppercase" : undefined}
                    aria-label={label}
                    onFocus={() => onFocusChange?.(true)}
                    onBlur={() => onFocusChange?.(false)}
                    onPaste={onPaste}
                    onKeyDown={onKeyDown}
                    onChange={(event) => {
                        if (mode === "ip") {
                            onChange(event.target.value);
                            return;
                        }
                        const input = event.target;
                        apply(
                            formatMacInput(input.value, input.selectionStart ?? input.value.length, {
                                value,
                                caret: Math.max(0, (input.selectionStart ?? 1) - 1)
                            })
                        );
                    }}
                />
                {mode === "mac" && digits > 0 && digits < 12 && (
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-foreground-subtle tabular-nums"
                    >
                        {t("connect.address.digits", { count: digits })}
                    </span>
                )}
            </div>
        </div>
    );
}

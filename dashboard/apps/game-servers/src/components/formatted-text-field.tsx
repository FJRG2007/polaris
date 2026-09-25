"use client";

/**
 * Text with Minecraft's colours and styles, edited the way people expect to:
 * select a word, press a colour. Written by the server's description first, and
 * shared now with everything else that sends formatted text to the game - an
 * announcement's title, subtitle, action bar and chat line.
 *
 * The value is the text with its `&` codes in it (`motd.ts`), so what is stored,
 * previewed and sent is one string read by one set of functions. The field shows
 * the words alone by default - the codes are an implementation detail - and
 * "Codes" shows them, for somebody faster at typing them or pasting from a
 * generator on the web.
 */

import { Code2, Plus } from "lucide-react";
import { Button, cn } from "@polaris/ui";
import * as mc from "../lib/minecraft/motd";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

export function FormattedTextField({
    value,
    onChange,
    rows,
    label,
    placeholder,
    singleLine = false,
    actions,
    footnote,
    inserts = []
}: {
    /** The text, with its `&` codes. */
    value: string;
    onChange: (next: string) => void;
    rows: number;
    /** What the field is, for a screen reader: it has no visible label of its
     *  own, because every screen using it already titles it. */
    label: string;
    placeholder?: string;
    /** A title is one line: Enter does not start a second. */
    singleLine?: boolean;
    /** More buttons beside "Codes", for the screen's own tools. */
    actions?: ReactNode;
    /** A line of help under the field, left of the buttons. */
    footnote?: ReactNode;
    /** Words the screen fills in when it sends the text, such as each player's
     *  name, offered as buttons that put them where the caret is. */
    inserts?: readonly { readonly label: string; readonly text: string; readonly title: string }[];
}) {
    // Whether the field holds the text or the codes.
    const [raw, setRaw] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);
    const map = useMemo(() => mc.motdMap(value), [value]);
    // What the caret is on, so the buttons can show whether their code is already
    // in force - a toggle that does not say which way it is pointing is a button
    // you press to find out.
    const [selection, setSelection] = useState({ start: 0, end: 0 });
    const active = useMemo(() => {
        const from = raw ? mc.plainIndexAt(map, selection.start) : selection.start;
        const to = raw ? mc.plainIndexAt(map, selection.end) : selection.end;
        return mc.codesOver(map, from, to);
    }, [map, raw, selection]);
    const shown = raw ? value : map.plain;

    /**
     * Apply a code to whatever is selected.
     *
     * The selection is wrapped, not replaced, and the formatting after it is put
     * back - so colouring a word colours that word. With nothing selected the
     * code lands at the caret and applies from there on, which is what the game
     * does with it.
     */
    const apply = useCallback(
        (code: string) => {
            const field = area.current;
            const from = field?.selectionStart ?? shown.length;
            const to = field?.selectionEnd ?? from;
            // The field's offsets are the stored string's in raw mode and the
            // visible text's in formatted mode; the edit is always in the latter.
            const start = raw ? mc.plainIndexAt(map, from) : from;
            const end = raw ? mc.plainIndexAt(map, to) : to;
            setSelection({ start: from, end: to });
            const next = mc.applyMotdCode(value, start, end, code);
            onChange(next.text);
            requestAnimationFrame(() => {
                if (!field) return;
                field.focus();
                const after = mc.motdMap(next.text);
                const caret = raw
                    ? [
                          after.offsets[next.start] ?? next.text.length,
                          after.offsets[next.end] ?? next.text.length
                      ]
                    : [next.start, next.end];
                field.setSelectionRange(caret[0] as number, caret[1] as number);
            });
        },
        [map, raw, shown.length, value, onChange]
    );

    /**
     * A colour outside the sixteen, applied from the caret onwards.
     *
     * Not toggled over a selection the way a named colour is. Sixteen shades can be
     * reasoned about as a set - is this one on, take it off - and sixteen million
     * cannot, so this does what a colour code does in the game: it holds until
     * something changes it.
     */
    const applyHex = useCallback(
        (hex: string) => {
            const field = area.current;
            const from = field?.selectionStart ?? shown.length;
            const start = raw ? mc.plainIndexAt(map, from) : from;
            const next = mc.applyMotdHex(value, start, hex);
            onChange(next.text);
            requestAnimationFrame(() => {
                if (!field) return;
                field.focus();
                const after = mc.motdMap(next.text);
                const caret = raw ? (after.offsets[next.start] ?? next.text.length) : next.start;
                field.setSelectionRange(caret, caret);
            });
        },
        [map, raw, shown.length, value, onChange]
    );

    /** Put a word the screen fills in where the caret is, over any selection. */
    const insert = useCallback(
        (word: string) => {
            const field = area.current;
            const from = field?.selectionStart ?? shown.length;
            const to = field?.selectionEnd ?? from;
            const next = raw
                ? `${value.slice(0, from)}${word}${value.slice(to)}`
                : mc.replaceMotdPlain(value, `${shown.slice(0, from)}${word}${shown.slice(to)}`);
            onChange(next);
            requestAnimationFrame(() => {
                if (!field) return;
                field.focus();
                field.setSelectionRange(from + word.length, from + word.length);
            });
        },
        [raw, shown, value, onChange]
    );

    /** What the person typed, folded back into the string with its codes. */
    const edit = useCallback(
        (typed: string) => {
            const text = singleLine ? typed.replace(/\r?\n/g, " ") : typed;
            onChange(raw ? text : mc.replaceMotdPlain(value, text));
        },
        [raw, singleLine, value, onChange]
    );

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1">
                {Object.entries(mc.MOTD_COLORS).map(([code, color]) => (
                    <button
                        key={code}
                        type="button"
                        onClick={() => apply(code)}
                        aria-label={color.name}
                        aria-pressed={active.color === code}
                        title={
                            active.color === code ? `${color.name} - press to clear` : color.name
                        }
                        className={cn(
                            "size-6 rounded border transition-transform hover:scale-110",
                            active.color === code
                                ? "border-foreground ring-2 ring-foreground/40"
                                : "border-border"
                        )}
                        style={{ backgroundColor: color.hex }}
                    />
                ))}
                {/* Anything the sixteen do not have. Modern servers draw it;
                    one old enough not to shows the nearest it knows, which is
                    the game's own behaviour rather than something to guard. */}
                <label
                    className="relative size-6 cursor-pointer overflow-hidden rounded border border-border transition-transform hover:scale-110"
                    title="Any other color"
                    style={{
                        background: "conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)"
                    }}
                >
                    <input
                        type="color"
                        className="absolute inset-0 cursor-pointer opacity-0"
                        aria-label="Any other color"
                        onChange={(event) => applyHex(event.target.value)}
                    />
                </label>
                <span className="mx-1 h-5 w-px bg-border" />
                {Object.entries(mc.MOTD_STYLES).map(([code, name]) => (
                    <Button
                        key={code}
                        size="sm"
                        variant="ghost"
                        onClick={() => apply(code)}
                        title={active.styles.includes(code) ? `${name} - press to remove` : name}
                        aria-label={name}
                        aria-pressed={active.styles.includes(code)}
                        className={cn(
                            "h-6 px-2 text-xs",
                            active.styles.includes(code) && "bg-primary/15 text-foreground"
                        )}
                    >
                        {name}
                    </Button>
                ))}
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => apply(mc.RESET)}
                    title="Reset the formatting from here on"
                    aria-label="Reset the formatting from here on"
                    className="h-6 px-2 text-xs"
                >
                    Reset
                </Button>
            </div>

            <textarea
                ref={area}
                value={shown}
                onChange={(event) => edit(event.target.value)}
                onKeyDown={(event) => {
                    if (singleLine && event.key === "Enter") event.preventDefault();
                }}
                onSelect={(event) =>
                    setSelection({
                        start: event.currentTarget.selectionStart,
                        end: event.currentTarget.selectionEnd
                    })
                }
                rows={rows}
                placeholder={placeholder}
                aria-label={raw ? `${label}, with its formatting codes` : label}
                spellCheck={false}
                className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm hover:border-border-strong focus:border-border-strong"
            />

            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{footnote}</span>
                <span className="flex items-center gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => setRaw((current) => !current)}
                        title={
                            raw
                                ? "Edit the text and let the buttons write the codes"
                                : "Edit the codes yourself"
                        }
                    >
                        <Code2 className="size-3.5" /> {raw ? "Formatted" : "Codes"}
                    </Button>
                    {inserts.map((one) => (
                        <Button
                            key={one.text}
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs"
                            onClick={() => insert(one.text)}
                            title={one.title}
                        >
                            <Plus className="size-3.5" /> {one.label}
                        </Button>
                    ))}
                    {actions}
                </span>
            </div>
        </div>
    );
}

/**
 * The popup's dropdown, in place of a native `<select>`.
 *
 * A native select draws an OS menu that ignores the popup's theme, so this is a
 * small listbox of its own (WAI-ARIA "select-only combobox" pattern): a button
 * that opens a list, arrows and Home/End to move, Enter or Space to pick, Escape
 * or Tab to close, and typing to jump to an option. The popup has no portal
 * layer, so the list opens upward when there is no room below it.
 */

import { edgeIndex, matchIndex, stepIndex } from "@/lib/listbox";
import { OpenMark } from "./marks";
import { useEffect, useId, useRef, useState } from "react";

export interface PickerOption<T extends string | number> {
    value: T;
    label: string;
    disabled?: boolean;
}

const TYPE_AHEAD_MS = 500;

export function Picker<T extends string | number>({
    id,
    value,
    options,
    onChange,
    "aria-labelledby": labelledBy
}: {
    id?: string;
    value: T;
    options: readonly PickerOption<T>[];
    onChange: (value: T) => void;
    "aria-labelledby"?: string;
}): React.JSX.Element {
    const listId = useId();
    const rootRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const typed = useRef({ text: "", at: 0 });
    const [open, setOpen] = useState(false);
    const [upward, setUpward] = useState(false);
    const selectedIndex = options.findIndex((option) => option.value === value);
    const [active, setActive] = useState(selectedIndex);
    const selected = options[selectedIndex];

    useEffect(() => {
        if (!open) return;
        listRef.current?.focus();
        const rect = rootRef.current?.getBoundingClientRect();
        const list = listRef.current?.offsetHeight ?? 0;
        setUpward(rect ? rect.bottom + list > window.innerHeight && rect.top > list : false);
        const close = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
    }, [open]);

    useEffect(() => {
        if (!open || active < 0) return;
        listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [open, active]);

    const show = (index: number) => {
        setActive(index >= 0 ? index : edgeIndex(options, "first"));
        setOpen(true);
    };
    const close = () => {
        setOpen(false);
        buttonRef.current?.focus();
    };
    const pick = (index: number) => {
        const option = options[index];
        if (!option || option.disabled) return;
        close();
        if (option.value !== value) onChange(option.value);
    };
    const typeAhead = (key: string, from: number): number => {
        const now = Date.now();
        const text = now - typed.current.at > TYPE_AHEAD_MS ? key : typed.current.text + key;
        typed.current = { text, at: now };
        return matchIndex(options, from, text);
    };

    const onButtonKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            show(selectedIndex);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const index = typeAhead(event.key, selectedIndex);
            if (index !== selectedIndex) pick(index);
        }
    };
    const onListKey = (event: React.KeyboardEvent<HTMLUListElement>) => {
        const move = (index: number) => {
            event.preventDefault();
            if (index >= 0) setActive(index);
        };
        switch (event.key) {
            case "ArrowDown":
                return move(stepIndex(options, active, 1));
            case "ArrowUp":
                return move(stepIndex(options, active, -1));
            case "Home":
                return move(edgeIndex(options, "first"));
            case "End":
                return move(edgeIndex(options, "last"));
            case "Enter":
            case " ":
                event.preventDefault();
                return pick(active);
            case "Escape":
                event.preventDefault();
                return close();
            case "Tab":
                return setOpen(false);
            default:
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    move(typeAhead(event.key, active));
                }
        }
    };

    return (
        <div className="picker" ref={rootRef}>
            <button
                ref={buttonRef}
                id={id}
                type="button"
                className="picker-button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                onClick={() => (open ? setOpen(false) : show(selectedIndex))}
                onKeyDown={onButtonKey}
            >
                <span className="picker-label">{selected?.label ?? ""}</span>
                <OpenMark />
            </button>
            {open ? (
                <ul
                    ref={listRef}
                    id={listId}
                    role="listbox"
                    tabIndex={-1}
                    aria-labelledby={labelledBy}
                    aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                    className={upward ? "picker-list up" : "picker-list"}
                    onKeyDown={onListKey}
                    onBlur={(event) => {
                        if (!rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
                    }}
                >
                    {options.map((option, index) => (
                        <li
                            key={String(option.value)}
                            id={`${listId}-${index}`}
                            data-index={index}
                            role="option"
                            aria-selected={index === selectedIndex}
                            aria-disabled={option.disabled || undefined}
                            className={index === active ? "active" : undefined}
                            onPointerMove={() => !option.disabled && setActive(index)}
                            onClick={() => pick(index)}
                        >
                            {option.label}
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

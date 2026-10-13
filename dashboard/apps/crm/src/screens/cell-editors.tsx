"use client";

/**
 * Editing one field in place: a box laid over the cell that takes what is typed,
 * says what is wrong with it while it is wrong, and keeps it with Enter or a
 * click anywhere else. Escape puts the cell back as it was.
 *
 * Each value is checked with the same `normalizeInput` the server runs, so what
 * the box accepts is what will be stored - a website typed as "acme.com/about"
 * is shown as the host it will become before it is kept.
 */

import { useCrmT } from "./i18n";
import { Star, X } from "lucide-react";
import { OptionChip } from "./cell-display";
import { currencyName } from "./format";
import { cn, Select } from "@polaris/ui";
import { CURRENCIES } from "@polaris/core";
import { hostUi } from "@polaris/app-host/client";
import type { FieldDef, FieldValue, FullName, Money } from "../model/objects";
import {
    MAX_RATING,
    normalizeInput,
    parseAmount,
    readChoices,
    typedCount,
    type InputValue
} from "../model/values";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface EditorProps {
    readonly field: FieldDef;
    readonly value: FieldValue | undefined;
    /** Keep a normalized value. */
    readonly onCommit: (value: InputValue) => void;
    readonly onCancel: () => void;
    /** What a new amount is in when the cell had none: the reader's currency. */
    readonly defaultCurrency?: string;
}

/**
 * The box over the cell. A press outside it keeps what was typed (or drops it
 * when it is not valid); a press inside a menu it opened - the currency list -
 * is still inside.
 */
function Overlay({
    onOutside,
    error,
    children,
    className
}: {
    onOutside: () => void;
    error: string | null;
    children: ReactNode;
    className?: string;
}) {
    const box = useRef<HTMLDivElement>(null);
    const outside = useRef(onOutside);
    outside.current = onOutside;
    useEffect(() => {
        const press = (event: PointerEvent) => {
            const target = event.target as Element | null;
            if (!target || box.current?.contains(target)) return;
            if (target.closest("[data-radix-popper-content-wrapper]")) return;
            outside.current();
        };
        document.addEventListener("pointerdown", press, true);
        return () => document.removeEventListener("pointerdown", press, true);
    }, []);
    return (
        <div
            ref={box}
            className={cn(
                "absolute -inset-px z-20 h-max min-w-full max-w-[min(24rem,80vw)] rounded-md border border-primary bg-elevated p-0.5 shadow-popover",
                className
            )}
            onClick={(event) => event.stopPropagation()}
        >
            {children}
            {error ? (
                <p className="px-1.5 pb-1 pt-0.5 text-[0.6875rem] text-danger">{error}</p>
            ) : null}
        </div>
    );
}

const FIELD_INPUT =
    "h-7 w-full min-w-0 rounded bg-transparent px-1.5 text-[0.8125rem] text-foreground outline-none placeholder:text-foreground-subtle";

/** Enter keeps, Escape drops; Tab keeps and lets the focus move on. */
function keys(event: KeyboardEvent, keep: () => void, drop: () => void) {
    if (event.key === "Enter") {
        event.preventDefault();
        keep();
    } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        drop();
    } else if (event.key === "Tab") {
        keep();
    }
}

function useCheck(field: FieldDef) {
    const t = useCrmT();
    return (raw: unknown): { value: InputValue | undefined; error: string | null } => {
        const result = normalizeInput(field, raw);
        if (result.ok) return { value: result.value, error: null };
        return { value: undefined, error: t(`invalid.${result.reason}`) };
    };
}

/** Text, an address, a phone number, a website, a domain or a count. */
export function TextEditor({ field, value, onCommit, onCancel }: EditorProps) {
    const t = useCrmT();
    const check = useCheck(field);
    const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
    const [touched, setTouched] = useState(false);
    const result = check(field.kind === "number" ? typedCount(text) : text);
    const keep = () => (result.value === undefined ? onCancel() : onCommit(result.value));
    const placeholder =
        field.kind === "domain"
            ? "acme.com"
            : field.kind === "url"
              ? "https://"
              : field.kind === "email"
                ? t("placeholders.email")
                : "";
    return (
        <Overlay onOutside={keep} error={touched ? result.error : null}>
            <input
                autoFocus
                className={FIELD_INPUT}
                value={text}
                inputMode={
                    field.kind === "number" ? "numeric" : field.kind === "phone" ? "tel" : undefined
                }
                type={field.kind === "email" ? "email" : "text"}
                placeholder={placeholder}
                aria-invalid={Boolean(touched && result.error)}
                aria-label={t(`fields.${field.key === "name" ? "nameOf" : "valueOf"}`)}
                onChange={(event) => {
                    setText(event.target.value);
                    setTouched(true);
                }}
                onKeyDown={(event) => keys(event, keep, onCancel)}
            />
        </Overlay>
    );
}

/** A person's first and last names, side by side. */
export function NameEditor({ field, value, onCommit, onCancel }: EditorProps) {
    const t = useCrmT();
    const check = useCheck(field);
    const start = (value as FullName | undefined) ?? { first: "", last: "" };
    const [name, setName] = useState(start);
    const [touched, setTouched] = useState(false);
    const result = check(name);
    const keep = () => (result.value === undefined ? onCancel() : onCommit(result.value));
    const edit = (part: keyof FullName) => (text: string) => {
        setName((current) => ({ ...current, [part]: text }));
        setTouched(true);
    };
    return (
        <Overlay onOutside={keep} error={touched ? result.error : null} className="w-[18rem]">
            <div className="flex gap-1">
                <input
                    autoFocus
                    className={FIELD_INPUT}
                    value={name.first}
                    placeholder={t("placeholders.firstName")}
                    aria-label={t("placeholders.firstName")}
                    onChange={(event) => edit("first")(event.target.value)}
                    onKeyDown={(event) => keys(event, keep, onCancel)}
                />
                <input
                    className={cn(FIELD_INPUT, "border-l border-border")}
                    value={name.last}
                    placeholder={t("placeholders.lastName")}
                    aria-label={t("placeholders.lastName")}
                    onChange={(event) => edit("last")(event.target.value)}
                    onKeyDown={(event) => keys(event, keep, onCancel)}
                />
            </div>
        </Overlay>
    );
}

/** An amount and its currency. */
export function MoneyEditor({ field, value, onCommit, onCancel, defaultCurrency }: EditorProps) {
    const t = useCrmT();
    const locale = hostUi.i18nProvider.useLocale();
    const check = useCheck(field);
    const start = (value as Money | null | undefined) ?? { amount: null, currency: "" };
    const [text, setText] = useState(start.amount === null ? "" : String(start.amount));
    const [currency, setCurrency] = useState(start.currency || defaultCurrency || "EUR");
    const [touched, setTouched] = useState(false);
    const amount = text.trim() === "" ? null : parseAmount(text);
    const result =
        text.trim() !== "" && amount === null
            ? { value: undefined, error: t("invalid.number") }
            : check({ amount, currency });
    const keep = () => (result.value === undefined ? onCancel() : onCommit(result.value));
    return (
        <Overlay onOutside={keep} error={touched ? result.error : null} className="w-[17rem]">
            <div className="flex items-center gap-1">
                <input
                    autoFocus
                    className={cn(FIELD_INPUT, "tabular-nums")}
                    value={text}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={t("fields.amountOf")}
                    onChange={(event) => {
                        setText(event.target.value);
                        setTouched(true);
                    }}
                    onKeyDown={(event) => keys(event, keep, onCancel)}
                />
                <Select
                    value={currency}
                    onValueChange={setCurrency}
                    aria-label={t("fields.currencyOf")}
                    className="h-7 w-24 shrink-0"
                    options={CURRENCIES.map((entry) => ({
                        value: entry.code,
                        label: `${entry.code} - ${currencyName(entry.code, locale)}`
                    }))}
                />
            </div>
        </Overlay>
    );
}

/** A day. */
export function DateEditor({ field, value, onCommit, onCancel }: EditorProps) {
    const t = useCrmT();
    const check = useCheck(field);
    const [text, setText] = useState((value as string | null | undefined) ?? "");
    const result = check(text);
    const keep = () => (result.value === undefined ? onCancel() : onCommit(result.value));
    return (
        <Overlay onOutside={keep} error={result.error} className="w-[13rem]">
            <div className="flex items-center gap-1">
                <input
                    autoFocus
                    type="date"
                    className={FIELD_INPUT}
                    value={text}
                    min="1900-01-01"
                    max="2999-12-31"
                    aria-label={t("fields.valueOf")}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => keys(event, keep, onCancel)}
                />
                {text ? (
                    <button
                        type="button"
                        className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-card-hover hover:text-foreground"
                        aria-label={t("actions.clear")}
                        title={t("actions.clear")}
                        onClick={() => onCommit(null)}
                    >
                        <X className="size-3.5" />
                    </button>
                ) : null}
            </div>
        </Overlay>
    );
}

/** A rating: a star clicked, or a digit typed (0 clears it). Clicking the
 *  stars it already has clears it too. */
export function RatingEditor({ value, onCommit, onCancel }: EditorProps) {
    const t = useCrmT();
    const current = typeof value === "number" ? value : 0;
    const [hover, setHover] = useState(0);
    const shown = hover || current;
    return (
        <Overlay onOutside={onCancel} error={null}>
            <div
                role="radiogroup"
                aria-label={t("fields.valueOf")}
                className="flex items-center gap-0.5 p-1"
                onKeyDown={(event) => {
                    const digit = Number(event.key);
                    if (/^[0-9]$/.test(event.key) && digit <= MAX_RATING) {
                        event.preventDefault();
                        onCommit(digit === 0 ? null : digit);
                    } else {
                        keys(event, onCancel, onCancel);
                    }
                }}
            >
                {Array.from({ length: MAX_RATING }, (_, index) => index + 1).map((stars) => (
                    <button
                        key={stars}
                        type="button"
                        role="radio"
                        aria-checked={stars === current}
                        autoFocus={stars === Math.max(current, 1)}
                        aria-label={t("values.stars", { count: stars })}
                        title={t("values.stars", { count: stars })}
                        className="grid size-7 place-items-center rounded hover:bg-card-hover"
                        onMouseEnter={() => setHover(stars)}
                        onMouseLeave={() => setHover(0)}
                        onClick={() => onCommit(stars === current ? null : stars)}
                    >
                        <Star
                            className={cn(
                                "size-4",
                                stars <= shown
                                    ? "fill-amber-400 text-amber-400"
                                    : "text-muted-foreground"
                            )}
                        />
                    </button>
                ))}
            </div>
        </Overlay>
    );
}

/** Several choices, ticked; kept when the editor is left or Enter is pressed. */
export function ChoicesEditor({ field, value, onCommit, onCancel }: EditorProps) {
    const t = useCrmT();
    const [chosen, setChosen] = useState(() => readChoices(value));
    const keep = () => {
        const result = normalizeInput(field, chosen);
        if (result.ok) onCommit(result.value);
        else onCancel();
    };
    return (
        <Overlay onOutside={keep} error={null}>
            <div
                role="group"
                aria-label={t("fields.valueOf")}
                className="flex max-h-64 min-w-48 flex-col overflow-y-auto p-1"
                onKeyDown={(event) => keys(event, keep, onCancel)}
            >
                {(field.options ?? []).map((option, index) => (
                    <label
                        key={option}
                        className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-card-hover"
                    >
                        <input
                            type="checkbox"
                            autoFocus={index === 0}
                            checked={chosen.includes(option)}
                            onChange={(event) =>
                                setChosen(
                                    event.target.checked
                                        ? [...chosen, option]
                                        : chosen.filter((one) => one !== option)
                                )
                            }
                        />
                        <OptionChip field={field} option={option} label={option} />
                    </label>
                ))}
            </div>
        </Overlay>
    );
}

/** The editor a kind of field is typed into, or null for one that is picked
 *  from a menu or toggled. */
export function editorFor(field: FieldDef): ((props: EditorProps) => ReactNode) | null {
    switch (field.kind) {
        case "text":
        case "email":
        case "phone":
        case "url":
        case "domain":
        case "number":
            return TextEditor;
        case "fullName":
            return NameEditor;
        case "currency":
            return MoneyEditor;
        case "date":
            return DateEditor;
        case "rating":
            return RatingEditor;
        case "multiSelect":
            return ChoicesEditor;
        default:
            return null;
    }
}

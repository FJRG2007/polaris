"use client";

/**
 * A row of recipients.
 *
 * Addresses become chips as soon as they are finished, so what has been entered
 * is countable at a glance rather than a comma-separated line somebody has to
 * read. Finished means a comma, a semicolon, Enter, Tab, or the field losing
 * focus - all five, because everybody has learned a different one.
 *
 * Suggestions come from what the mailboxes have actually corresponded with,
 * ranked so the person written to daily is first. Nothing is offered until two
 * characters have been typed: a list that appears on the first keystroke is a
 * list of everybody.
 *
 * The address is validated as it is entered rather than at send time. A field
 * that has not been filled in is incomplete, not wrong, so an empty one says
 * nothing; only something typed that cannot be an address is marked.
 */

import { X } from "lucide-react";
import * as core from "@polaris/core";
import { Input, cn } from "@polaris/ui";
import { suggestContactsAction } from "./actions";
import { useEffect, useMemo, useRef, useState } from "react";

/** How long typing settles before contacts are asked for. */
const SETTLE_MS = 200;

export function RecipientField({
    label,
    value,
    onChange,
    autoFocus
}: {
    label: string;
    value: core.MailAddress[];
    onChange: (next: core.MailAddress[]) => void;
    autoFocus?: boolean;
}) {
    const [typed, setTyped] = useState("");
    const [suggestions, setSuggestions] = useState<{ address: string; name: string }[]>([]);
    const [highlight, setHighlight] = useState(0);
    const box = useRef<HTMLInputElement | null>(null);

    const invalid = useMemo(() => typed.trim().length > 0 && !looksLikeAddress(typed), [typed]);

    useEffect(() => {
        const needle = typed.trim();
        if (needle.length < 2) {
            setSuggestions([]);
            return;
        }
        const timer = setTimeout(() => {
            void (async () => {
                const outcome = await suggestContactsAction(needle);
                setSuggestions(outcome.suggestions.filter((one) => !value.some((held) => core.sameAddress(held.address, one.address))));
                setHighlight(0);
            })();
        }, SETTLE_MS);
        return () => clearTimeout(timer);
    }, [typed, value]);

    function commit(entry: { address: string; name: string }): void {
        if (!looksLikeAddress(entry.address)) return;
        if (value.some((held) => core.sameAddress(held.address, entry.address))) {
            setTyped("");
            return;
        }
        onChange([...value, { name: entry.name, address: entry.address.trim().toLowerCase() }]);
        setTyped("");
        setSuggestions([]);
    }

    return (
        <div className="relative flex items-start gap-2 text-[12px] text-muted-foreground">
            <span className="w-10 shrink-0 pt-1.5">{label}</span>
            <div className="min-w-0 flex-1">
                <div
                    className={cn(
                        "flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-border bg-field px-1.5 py-1",
                        invalid && "border-danger"
                    )}
                >
                    {value.map((entry) => (
                        <span
                            key={entry.address}
                            className="flex max-w-full items-center gap-1 rounded bg-card px-1.5 py-0.5 text-[12px] text-foreground"
                        >
                            <span
                                className="truncate"
                                title={
                                    entry.name.trim()
                                        ? `${entry.name.trim()} <${entry.address}>`
                                        : entry.address
                                }
                            >
                                {entry.name.trim() || entry.address}
                            </span>
                            <button
                                type="button"
                                aria-label={`Remove ${entry.address}`}
                                title={`Remove ${entry.address}`}
                                className="text-foreground-subtle hover:text-foreground"
                                onClick={() => onChange(value.filter((held) => held.address !== entry.address))}
                            >
                                <X className="size-3 shrink-0" aria-hidden />
                            </button>
                        </span>
                    ))}
                    <Input
                        ref={box}
                        autoFocus={autoFocus}
                        value={typed}
                        aria-label={label}
                        aria-invalid={invalid || undefined}
                        className="h-6 min-w-[8rem] flex-1 border-0 bg-transparent px-1 text-[13px]"
                        onChange={(event) => setTyped(event.target.value)}
                        onBlur={() => {
                            // Leaving the field finishes what is in it. Losing a
                            // typed address because somebody clicked Send is the
                            // single most annoying bug a composer can have.
                            if (looksLikeAddress(typed)) commit({ address: typed, name: "" });
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowDown" && suggestions.length > 0) {
                                event.preventDefault();
                                setHighlight((held) => (held + 1) % suggestions.length);
                                return;
                            }
                            if (event.key === "ArrowUp" && suggestions.length > 0) {
                                event.preventDefault();
                                setHighlight((held) => (held - 1 + suggestions.length) % suggestions.length);
                                return;
                            }
                            if (event.key === "Enter" || event.key === "Tab" || event.key === "," || event.key === ";") {
                                const chosen = suggestions[highlight];
                                if (event.key === "Enter" && chosen) {
                                    event.preventDefault();
                                    commit(chosen);
                                    return;
                                }
                                if (looksLikeAddress(typed)) {
                                    event.preventDefault();
                                    commit({ address: typed, name: "" });
                                }
                                return;
                            }
                            if (event.key === "Backspace" && typed === "" && value.length > 0) {
                                onChange(value.slice(0, -1));
                            }
                        }}
                    />
                </div>
                {invalid ? (
                    <p className="mt-0.5 text-[11px] text-danger">That is not an email address.</p>
                ) : null}

                {suggestions.length > 0 ? (
                    <ul className="absolute left-12 right-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-elevated py-1 shadow-popover">
                        {suggestions.map((entry, index) => (
                            <li key={entry.address}>
                                <button
                                    type="button"
                                    className={cn(
                                        "flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-[13px]",
                                        index === highlight ? "bg-card text-foreground" : "text-muted-foreground"
                                    )}
                                    // Pressing a suggestion must not blur the box
                                    // first, or the half-typed address commits and
                                    // the suggestion lands on top of it.
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => {
                                        commit(entry);
                                        box.current?.focus();
                                    }}
                                >
                                    <span className="min-w-0 truncate text-foreground">
                                        {entry.name.trim() || entry.address}
                                    </span>
                                    {entry.name.trim() ? (
                                        <span className="min-w-0 truncate text-[12px] text-foreground-subtle">
                                            {entry.address}
                                        </span>
                                    ) : null}
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        </div>
    );
}

/** The same shape the schema enforces on the server: one @ with something either
 *  side, no spaces, and a dot in the domain. Deliberately not a strict RFC
 *  parser - real mailboxes exist that one refuses. */
function looksLikeAddress(value: string): boolean {
    return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value.trim());
}

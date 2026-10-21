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
 * ranked so the person written to daily is first - see `contact-suggestions`,
 * which the search panel's address fields share.
 *
 * The address is validated as it is entered rather than at send time. A field
 * that has not been filled in is incomplete, not wrong, so an empty one says
 * nothing; only something typed that cannot be an address is marked.
 */

import { X } from "lucide-react";
import * as core from "@polaris/core";
import { Input, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ContactSuggestionList, useContactSuggestions } from "./contact-suggestions";
import { useMemo, useRef, useState } from "react";

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
    const t = useTranslations("mailCompose");
    const [typed, setTyped] = useState("");
    const box = useRef<HTMLInputElement | null>(null);
    const chips = useRef<HTMLDivElement | null>(null);
    const held = useMemo(() => value.map((entry) => entry.address), [value]);
    const offered = useContactSuggestions(typed, held);
    const { suggestions, highlight } = offered;

    const invalid = useMemo(() => typed.trim().length > 0 && !looksLikeAddress(typed), [typed]);

    function commit(entry: { address: string; name: string }): void {
        if (!looksLikeAddress(entry.address)) return;
        if (value.some((held) => core.sameAddress(held.address, entry.address))) {
            setTyped("");
            return;
        }
        onChange([...value, { name: entry.name, address: entry.address.trim().toLowerCase() }]);
        setTyped("");
        offered.clear();
    }

    return (
        <div className="flex items-start gap-2 text-[12px] text-muted-foreground">
            <span className="w-12 shrink-0 pt-1.5">{label}</span>
            <div className="min-w-0 flex-1">
                <div
                    ref={chips}
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
                                {core.addressName(entry)}
                            </span>
                            <button
                                type="button"
                                aria-label={t("recipients.remove", { address: entry.address })}
                                title={t("recipients.remove", { address: entry.address })}
                                className="text-foreground-subtle hover:text-foreground"
                                onClick={() =>
                                    onChange(value.filter((held) => held.address !== entry.address))
                                }
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
                                offered.move(1);
                                return;
                            }
                            if (event.key === "ArrowUp" && suggestions.length > 0) {
                                event.preventDefault();
                                offered.move(-1);
                                return;
                            }
                            if (
                                event.key === "Enter" ||
                                event.key === "Tab" ||
                                event.key === "," ||
                                event.key === ";"
                            ) {
                                const chosen = suggestions[highlight];
                                if (event.key === "Enter" && chosen) {
                                    event.preventDefault();
                                    commit(chosen);
                                    return;
                                }
                                if (looksLikeAddress(typed)) {
                                    event.preventDefault();
                                    commit({ address: typed, name: "" });
                                    return;
                                }
                                // Enter in this box is never anything else's.
                                // Left to travel it reached the list behind the
                                // composer, which opened whichever conversation
                                // its cursor happened to be on - in the middle of
                                // somebody typing an address.
                                if (event.key === "Enter") event.preventDefault();
                                return;
                            }
                            if (event.key === "Escape" && suggestions.length > 0) {
                                // The list, not the composer: Escape closes the
                                // nearest thing that is open.
                                event.preventDefault();
                                event.stopPropagation();
                                offered.clear();
                                return;
                            }
                            if (event.key === "Backspace" && typed === "" && value.length > 0) {
                                onChange(value.slice(0, -1));
                            }
                        }}
                    />
                </div>
                {invalid ? (
                    <p className="mt-0.5 text-[11px] text-danger">{t("recipients.invalid")}</p>
                ) : null}

                <ContactSuggestionList
                    anchor={chips}
                    suggestions={suggestions}
                    highlight={highlight}
                    onHighlight={offered.setHighlight}
                    onChoose={(entry) => {
                        commit(entry);
                        box.current?.focus();
                    }}
                />
            </div>
        </div>
    );
}

/** Whether the server will take it: the shared address schema itself, so a chip
 *  the field accepts is never one the send refuses. */
function looksLikeAddress(value: string): boolean {
    return core.mailAddress.safeParse(value).success;
}

"use client";

/**
 * An editable list of values as chips, with real-time validation.
 *
 * Shared by the address lists and by a rule condition's values, which differ only in
 * what counts as valid - one takes addresses and ranges, the other takes whatever the
 * chosen field accepts. Its own module rather than a local helper because both of
 * those now live in separate files.
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button, Input } from "@polaris/ui";
import { isCidr, isIpAddress } from "@polaris/core";

/** True if a trimmed entry is a valid single IP or CIDR range. */
export function validAddress(value: string): boolean {
    const trimmed = value.trim();
    return isCidr(trimmed) || isIpAddress(trimmed);
}

export function ChipList({
    entries,
    onChange,
    placeholder,
    accent = "neutral",
    validate,
    invalidMessage,
    disabled
}: {
    entries: string[];
    onChange: (next: string[]) => void;
    placeholder: string;
    accent?: "neutral" | "deny";
    /** What counts as an entry. Defaults to anything non-empty. */
    validate?: (value: string) => boolean;
    invalidMessage?: string;
    disabled?: boolean;
}) {
    const [draft, setDraft] = useState("");
    const trimmed = draft.trim();
    const ok = trimmed !== "" && (validate ? validate(trimmed) : true);
    const duplicate = entries.includes(trimmed);
    const invalid = trimmed !== "" && !ok;

    function add() {
        if (!ok || duplicate) return;
        onChange([...entries, trimmed]);
        setDraft("");
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex gap-2">
                <Input
                    value={draft}
                    disabled={disabled}
                    placeholder={placeholder}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add();
                        }
                    }}
                    aria-invalid={invalid}
                />
                <Button
                    type="button"
                    variant="secondary"
                    onClick={add}
                    disabled={disabled || !ok || duplicate}
                    title="Add"
                    aria-label={`Add ${trimmed || "entry"}`}
                >
                    <Plus className="size-4" aria-hidden="true" />
                </Button>
            </div>
            {invalid && invalidMessage ? <p className="text-xs text-danger">{invalidMessage}</p> : null}
            {duplicate && trimmed !== "" ? <p className="text-xs text-muted-foreground">Already in the list.</p> : null}
            {entries.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {entries.map((entry) => (
                        <span
                            key={entry}
                            className={`inline-flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-xs ${
                                accent === "deny" ? "bg-danger/10 text-danger" : "bg-muted text-foreground"
                            }`}
                        >
                            <span className="truncate [overflow-wrap:anywhere]" title={entry}>
                                {entry}
                            </span>
                            <button
                                type="button"
                                disabled={disabled}
                                aria-label={`Remove ${entry}`}
                                title="Remove"
                                onClick={() => onChange(entries.filter((value) => value !== entry))}
                                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                            >
                                <X className="size-3" aria-hidden="true" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

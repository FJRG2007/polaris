"use client";

/**
 * A list of rules typed one at a time and shown as removable chips: the shape
 * every allowlist on the account is edited in - the addresses a session may come
 * from, and the clients an API key answers to.
 *
 * One component for all of them so a rule is added, rejected and removed the same
 * way wherever it appears, and so a list that refuses entries reads differently
 * from one that permits them without either surface inventing its own colours.
 *
 * Controlled: the parent owns the list. Validation is the caller's, since what
 * makes a valid entry is the only thing that differs between them.
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button, Input, cn } from "@polaris/ui";

export function RuleListInput({
    label,
    placeholder,
    hint,
    values,
    tone = "allow",
    validate,
    onChange
}: {
    label: string;
    placeholder: string;
    /** One line under the field, for the lists whose syntax is not obvious. */
    hint?: string;
    values: string[];
    /** Whether an entry here lets something in or keeps it out. Only the colour
     *  changes; a deny list that looked like an allow list is a misread waiting
     *  to happen on a screen where both appear together. */
    tone?: "allow" | "deny";
    /** The entry to store, or an error to show. Returning null rejects it. */
    validate: (draft: string) => { value: string } | { error: string };
    onChange: (next: string[]) => void;
}) {
    const [draft, setDraft] = useState("");
    const [error, setError] = useState<string | null>(null);

    function add() {
        const parsed = validate(draft);
        if ("error" in parsed) {
            setError(parsed.error);
            return;
        }
        setError(null);
        setDraft("");
        if (values.includes(parsed.value)) return;
        onChange([...values, parsed.value]);
    }

    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="flex gap-2">
                <Input
                    value={draft}
                    placeholder={placeholder}
                    autoComplete="off"
                    aria-label={label}
                    aria-invalid={error ? true : undefined}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add();
                        }
                    }}
                />
                <Button type="button" variant="ghost" onClick={add} disabled={draft.trim() === ""}>
                    <Plus className="size-4" />
                    Add
                </Button>
            </div>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            {values.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                    {values.map((entry) => (
                        <span
                            key={entry}
                            className={cn(
                                "flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs",
                                tone === "deny"
                                    ? "border-danger/40 bg-danger/5 text-danger"
                                    : "border-primary/40 bg-primary/5 text-primary"
                            )}
                        >
                            {entry}
                            <button
                                type="button"
                                aria-label={`Remove ${entry}`}
                                onClick={() => onChange(values.filter((value) => value !== entry))}
                            >
                                <X className="size-3" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

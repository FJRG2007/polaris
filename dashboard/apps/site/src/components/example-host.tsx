"use client";

/**
 * The reader's own Polaris address, set once and used by every example on the
 * site. Kept in this browser only; every storage access is guarded, since a
 * private window or blocked site data throws on it.
 */

import { cn } from "@polaris/ui";
import { useState, useSyncExternalStore } from "react";
import { EXAMPLE_HOST, readerOrigin, withReaderOrigin } from "@/lib/example-origin";

const KEY = "polaris-site-host";
const EVENT = "polaris-site-host";

function read(): string | null {
    try {
        return readerOrigin(window.localStorage.getItem(KEY) ?? "");
    } catch {
        return null;
    }
}

function write(origin: string | null): void {
    try {
        if (origin) window.localStorage.setItem(KEY, origin);
        else window.localStorage.removeItem(KEY);
    } catch {
        // Not kept past this page; the examples still change for now.
    }
    current = origin;
    window.dispatchEvent(new Event(EVENT));
}

let current: string | null | undefined;

function subscribe(changed: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key !== KEY) return;
        current = read();
        changed();
    };
    window.addEventListener(EVENT, changed);
    window.addEventListener("storage", onStorage);
    return () => {
        window.removeEventListener(EVENT, changed);
        window.removeEventListener("storage", onStorage);
    };
}

/** The reader's origin, or null for the placeholder. Null on the server and the first paint. */
export function useReaderOrigin(): string | null {
    return useSyncExternalStore(
        subscribe,
        () => (current === undefined ? (current = read()) : current),
        () => null
    );
}

/** Built-at-build-time HTML with the reader's address in its examples. */
export function HostedHtml({ html, className }: { html: string; className?: string }) {
    const origin = useReaderOrigin();
    return (
        <div
            className={className}
            // Rendered at build time from this repository's own text; the address is validated and escaped.
            dangerouslySetInnerHTML={{ __html: withReaderOrigin(html, origin, true) }}
        />
    );
}

export interface HostFieldWords {
    label: string;
    hint: string;
    invalid: string;
    reset: string;
}

/** The address field: typed once, applied as soon as it is a valid address. */
export function HostField({ words, className }: { words: HostFieldWords; className?: string }) {
    const origin = useReaderOrigin();
    const [draft, setDraft] = useState<string | null>(null);
    const shown = draft ?? (origin ? origin.replace(/^https:\/\//, "") : "");
    const invalid = draft !== null && draft.trim() !== "" && readerOrigin(draft) === null;

    function change(value: string) {
        setDraft(value);
        if (value.trim() === "") return write(null);
        const next = readerOrigin(value);
        if (next) write(next);
    }

    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            <label className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span className="shrink-0 text-muted-foreground">{words.label}</span>
                <input
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={shown}
                    placeholder={EXAMPLE_HOST}
                    onChange={(event) => change(event.target.value)}
                    onBlur={() => setDraft(null)}
                    aria-invalid={invalid || undefined}
                    title={words.hint}
                    className={cn(
                        "h-8 min-w-0 flex-1 rounded-md border border-border bg-field px-2.5 font-mono text-[0.8125rem] outline-none transition-colors focus:border-border-strong sm:max-w-xs",
                        invalid && "border-danger"
                    )}
                />
                {origin ? (
                    <button
                        type="button"
                        onClick={() => {
                            setDraft(null);
                            write(null);
                        }}
                        className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                        {words.reset}
                    </button>
                ) : null}
            </label>
            <p className={cn("text-xs", invalid ? "text-danger" : "text-muted-foreground")}>
                {invalid ? words.invalid : words.hint}
            </p>
        </div>
    );
}

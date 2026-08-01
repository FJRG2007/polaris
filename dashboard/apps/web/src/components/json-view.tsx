"use client";

/**
 * JSON as Polaris shows it everywhere: the same highlighter that paints files in
 * Drive, so a policy document, an audit detail and a stored file all read alike.
 *
 * Two surfaces, one paint. `JsonBlock` renders a document nobody may change;
 * `JsonEditor` puts a transparent textarea exactly on top of the painted code so
 * editing keeps the colors - both layers share one grid cell, which is what makes
 * their metrics identical and the caret land where the character is.
 *
 * The markup handed to the DOM is highlight.js' own. It escapes the source it is
 * given, so the only tags in it are the `span` elements it adds; a document that
 * cannot be parsed as a grammar simply comes back unpainted.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { CopyButton } from "@/components/copy-button";
import { useHighlighter } from "@/lib/code-highlight";

/** Metrics both layers of the editor must agree on, to the pixel. */
const CODE_LAYER = "col-start-1 row-start-1 whitespace-pre p-3 font-mono text-xs leading-relaxed";

/**
 * Re-indent a JSON document, leaving anything unparseable exactly as it came in.
 * Formatting is not what tells us a document changed, so callers compare against
 * this rather than the raw string.
 */
export function prettyJson(value: string): string {
    try {
        return JSON.stringify(JSON.parse(value) as unknown, null, 2);
    } catch {
        return value;
    }
}

/** Whether a document parses. Blank counts as valid: it is not yet wrong. */
export function isValidJson(value: string): boolean {
    if (value.trim() === "") return true;
    try {
        JSON.parse(value);
        return true;
    } catch {
        return false;
    }
}

/** The painted layer. Falls back to plain text until the grammar has loaded. */
function Painted({ code, className }: { code: string; className?: string }) {
    const highlight = useHighlighter("json");
    const painted = highlight ? highlight(code, "json") : null;

    // The trailing newline gives the last line a box of its own, so the caret at
    // the end of the document stays visible while editing.
    return (
        <pre className={cn(CODE_LAYER, className)}>
            {painted === null ? (
                <code>{`${code}\n`}</code>
            ) : (
                <code dangerouslySetInnerHTML={{ __html: `${painted}\n` }} />
            )}
        </pre>
    );
}

/** A JSON document nobody may change: highlighted, scrollable, copyable. */
export function JsonView({
    value,
    className,
    /** Offered unless the document is only a fragment of what the user sees. */
    copyable = true,
    label = "JSON"
}: {
    value: string;
    className?: string;
    copyable?: boolean;
    label?: string;
}) {
    const code = prettyJson(value);

    return (
        <div className={cn("group relative overflow-auto rounded-md border border-border bg-muted/40", className)}>
            {copyable ? (
                <CopyButton
                    value={code}
                    label={label}
                    className="absolute right-2 top-2 z-10 transition-opacity focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                />
            ) : null}
            <Painted code={code} />
        </div>
    );
}

/**
 * An editable JSON document. Controlled - the parent owns the text - and honest
 * about a document that no longer parses, which the server would refuse anyway.
 */
export function JsonEditor({
    value,
    onChange,
    label,
    disabled = false,
    className
}: {
    value: string;
    onChange: (next: string) => void;
    /** Names the field for assistive technology. */
    label: string;
    disabled?: boolean;
    className?: string;
}) {
    const [touched, setTouched] = useState(false);
    const invalid = touched && !isValidJson(value);

    return (
        <div className="flex flex-col gap-1">
            <div
                className={cn(
                    "overflow-auto rounded-md border bg-surface",
                    invalid ? "border-danger" : "border-input",
                    className
                )}
            >
                {/* The min height lives on the grid, not the box: the row is what
                    both layers stretch to, so clicking under a short document
                    still lands in the textarea. */}
                <div className="grid min-h-40 w-fit min-w-full">
                    <Painted code={value} className="pointer-events-none" />
                    <textarea
                        value={value}
                        onChange={(event) => {
                            setTouched(true);
                            onChange(event.target.value);
                        }}
                        onBlur={() => setTouched(true)}
                        wrap="off"
                        spellCheck={false}
                        disabled={disabled}
                        aria-label={label}
                        aria-invalid={invalid}
                        className={cn(
                            CODE_LAYER,
                            "resize-none overflow-hidden border-0 bg-transparent text-transparent caret-foreground outline-none"
                        )}
                    />
                </div>
            </div>
            {invalid ? <p className="text-xs text-danger">This is not valid JSON.</p> : null}
        </div>
    );
}

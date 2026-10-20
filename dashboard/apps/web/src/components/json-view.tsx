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
import { useTranslations } from "@/components/i18n/i18n-provider";

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
function Painted({
    code,
    className,
    language = "json"
}: {
    code: string;
    className?: string;
    /** A highlight.js token: an extension or a Markdown fence tag. */
    language?: string;
}) {
    const highlight = useHighlighter(language);
    const painted = highlight ? highlight(code, language) : null;

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

/**
 * Code nobody may change, in any grammar the highlighter knows - a curl
 * command, an HTTP header, a config file - painted the way `JsonView` paints
 * JSON. Not for logs or prose: those have no grammar and stay plain text.
 */
export function CodeView({
    value,
    language,
    className,
    copyable = true,
    label
}: {
    value: string;
    /** A highlight.js token: `bash`, `http`, `yaml`, a file's extension. */
    language: string;
    className?: string;
    copyable?: boolean;
    /** What the copy button copies, for its name. */
    label: string;
}) {
    return (
        <div
            className={cn(
                "group relative overflow-auto overscroll-contain rounded-md border border-border bg-muted/40",
                className
            )}
        >
            {copyable ? (
                <CopyButton
                    value={value}
                    label={label}
                    className="absolute right-2 top-2 z-10 transition-opacity focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                />
            ) : null}
            <Painted code={value} language={language} />
        </div>
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
    return (
        <CodeView
            value={prettyJson(value)}
            language="json"
            className={className}
            copyable={copyable}
            label={label}
        />
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
    error = null,
    className
}: {
    value: string;
    onChange: (next: string) => void;
    /** Names the field for assistive technology. */
    label: string;
    disabled?: boolean;
    /** The caller's own reason the document is refused; shown instead of the parse error. */
    error?: string | null;
    className?: string;
}) {
    const t = useTranslations("components");
    const [touched, setTouched] = useState(false);
    const message = error ?? (touched && !isValidJson(value) ? t("json.invalid") : null);
    const invalid = message !== null;

    return (
        <div className="flex flex-col gap-1">
            <div
                className={cn(
                    "overflow-auto overscroll-contain rounded-md border bg-surface",
                    invalid ? "border-danger" : "border-border",
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
            {invalid ? <p className="text-xs text-danger">{message}</p> : null}
        </div>
    );
}

/**
 * A short editable block of code in any grammar - a shell command, a config
 * file - painted as it is typed, the way `JsonEditor` paints JSON. The field's
 * label, validation and error line stay the caller's: this is only the box, so
 * it takes the `id`, `aria-invalid` and blur a plain textarea would.
 */
export function CodeEditor({
    value,
    onChange,
    language,
    id,
    label,
    invalid = false,
    onBlur,
    placeholder,
    disabled = false,
    className
}: {
    value: string;
    onChange: (next: string) => void;
    /** A highlight.js token, or null to leave the text unpainted. */
    language: string | null;
    /** For a `<label htmlFor>` the caller draws. */
    id?: string;
    /** Names the field when no label element points at it. */
    label?: string;
    invalid?: boolean;
    onBlur?: () => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "overflow-auto overscroll-contain rounded-md border bg-surface",
                invalid ? "border-danger" : "border-border",
                className
            )}
        >
            {/* The min height lives on the grid so a click under a short
                command still lands in the textarea. */}
            <div className="grid min-h-20 w-fit min-w-full">
                {language ? (
                    <Painted code={value} language={language} className="pointer-events-none" />
                ) : (
                    <pre className={cn(CODE_LAYER, "pointer-events-none")}>{`${value}\n`}</pre>
                )}
                <textarea
                    id={id}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    onBlur={onBlur}
                    wrap="off"
                    spellCheck={false}
                    disabled={disabled}
                    placeholder={placeholder}
                    aria-label={label}
                    aria-invalid={invalid || undefined}
                    className={cn(
                        CODE_LAYER,
                        "resize-none overflow-hidden border-0 bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground"
                    )}
                />
            </div>
        </div>
    );
}

"use client";

/**
 * A block of code, painted and optionally editable.
 *
 * Editing keeps the highlighting: a transparent textarea sits exactly on top of
 * the painted code, both stacked in one grid cell so they share their metrics
 * and the caret lands where the character is. Getting that alignment right is
 * fiddly and easy to break, so it lives in one place - the Drive code viewer,
 * the snippet editor and the public snippet page all paint through this.
 *
 * The grammar loads once for the language it is given, which is what lets the
 * paint keep up with typing.
 */

import { cn } from "@polaris/ui";
import { useHighlighter } from "@/lib/code-highlight";

/** Metrics both layers must agree on, to the pixel. */
const CODE_LAYER = "col-start-1 row-start-1 whitespace-pre p-4 font-mono text-xs leading-relaxed";

export function CodeSurface({
    code,
    language,
    onChange,
    ariaLabel,
    className
}: {
    code: string;
    /** A highlight.js token, or null to leave the text unpainted. */
    language: string | null;
    /** When given, the block is editable. */
    onChange?: (value: string) => void;
    ariaLabel?: string;
    className?: string;
}) {
    const highlight = useHighlighter(language);
    const painted = language && highlight ? highlight(code, language) : null;
    const editing = onChange !== undefined;

    return (
        <div className={cn("min-h-0 flex-1 overflow-auto", className)}>
            <div className="flex min-h-full w-fit min-w-full">
                <LineNumbers count={code.split("\n").length} />
                <div className="grid flex-1">
                    {/* The trailing newline gives the last line a box of its own,
                        so the caret at the end of the file stays visible. */}
                    <pre className={CODE_LAYER} aria-hidden={editing}>
                        {painted === null ? (
                            <code>{`${code}\n`}</code>
                        ) : (
                            <code dangerouslySetInnerHTML={{ __html: `${painted}\n` }} />
                        )}
                    </pre>
                    {onChange ? (
                        <textarea
                            value={code}
                            onChange={(event) => onChange(event.target.value)}
                            wrap="off"
                            spellCheck={false}
                            aria-label={ariaLabel}
                            className={cn(
                                CODE_LAYER,
                                "resize-none overflow-hidden border-0 bg-transparent text-transparent caret-foreground outline-none"
                            )}
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
}

/** The gutter. Sticky, so the numbers stay put when a long line scrolls sideways. */
function LineNumbers({ count }: { count: number }) {
    const numbers: string[] = [];
    for (let line = 1; line <= count; line++) numbers.push(String(line));

    return (
        <pre
            aria-hidden
            className="sticky left-0 select-none border-r border-border bg-surface py-4 pl-4 pr-3 text-right font-mono text-xs leading-relaxed text-muted-foreground"
        >
            {numbers.join("\n")}
        </pre>
    );
}

"use client";

/**
 * The codes a site hands out for the day the authenticator is gone.
 *
 * They are the most valuable thing in a two-factor setup and the worst kept: a
 * screenshot, a text file in Downloads, a note in an email to yourself. A vault
 * is where they belong, and they belong there behind the same press as a
 * password - which is what they are.
 *
 * Two ways in, because sites print them two ways: pasted out of the page, or the
 * `.txt` the site offered to download. Both are read by the same rule, which
 * splits on whitespace and takes off the numbering a list adds - the code itself
 * never contains a space, which is what makes that reliable.
 *
 * Copying one marks it used. Not because Polaris knows the site accepted it, but
 * because "which of these have I already burned" is the question somebody has at
 * three in the morning with one working code left, and the only moment anybody
 * could answer it is the moment they take one. It is a mark rather than a
 * deletion: unticking it is one press, and a code wrongly struck off would
 * otherwise be a code somebody believes they no longer have.
 */

import * as core from "@polaris/core";
import { useRef, useState } from "react";
import { Button, cn } from "@polaris/ui";
import { Check, Copy, FileUp, RotateCcw } from "lucide-react";

/** A used code is marked in the value itself rather than in a second field: one
 *  string is what gets encrypted, stored and read back by every other client,
 *  and a mark that lived somewhere else would not survive the trip. */
const USED_MARK = "-";

/** Whether a stored line is a code that has been used. */
export function codeUsed(line: string): boolean {
    return line.startsWith(USED_MARK);
}

/** The code itself, without the mark. */
export function codeText(line: string): string {
    return codeUsed(line) ? line.slice(USED_MARK.length) : line;
}

/** The same line, struck through or restored. */
export function withUsed(line: string, used: boolean): string {
    const text = codeText(line);
    return used ? `${USED_MARK}${text}` : text;
}

export function RecoveryCodes({
    value,
    onChange,
    readOnly = false
}: {
    /** The stored field: one code per line, a leading dash meaning used. */
    value: string;
    onChange?: (value: string) => void;
    /** The detail view passes this: codes can be copied and struck off, but the
     *  list itself is edited in the form. */
    readOnly?: boolean;
}) {
    const file = useRef<HTMLInputElement>(null);
    const [pasting, setPasting] = useState("");
    const [copied, setCopied] = useState<number | null>(null);

    const lines = value.split("\n").filter((line) => line.trim().length > 0);
    const left = lines.filter((line) => !codeUsed(line)).length;

    const take = (codes: string[]) => {
        // Added rather than replacing: a site that hands out a second set does
        // not invalidate the first, and somebody pasting twice has not asked for
        // anything to be thrown away.
        const existing = new Set(lines.map((line) => codeText(line)));
        const fresh = codes.filter((code) => !existing.has(code));
        onChange?.([...lines, ...fresh].join("\n"));
        setPasting("");
    };

    const readFile = async (picked: File) => {
        // A `.txt` or a `.csv`, which is what sites offer - and read by exactly
        // the same rule, since a CSV of recovery codes is a list of codes with
        // commas in it.
        const text = await picked.text();
        take(core.readRecoveryCodes(text.replace(/,/g, " ")));
    };

    const copyCode = async (index: number) => {
        const line = lines[index];
        if (!line) return;
        await navigator.clipboard.writeText(codeText(line));
        setCopied(index);
        window.setTimeout(() => setCopied(null), 2000);
        // Struck off as it is taken. The only moment anybody could record this
        // is the moment they use one.
        if (!codeUsed(line) && onChange) {
            onChange(lines.map((entry, at) => (at === index ? withUsed(entry, true) : entry)).join("\n"));
        }
    };

    return (
        <div className="flex flex-col gap-2">
            {lines.length > 0 ? (
                <>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                            {left} of {lines.length} still unused
                        </span>
                        {!readOnly && left === 0 ? (
                            // The sentence that matters: a set with nothing left
                            // is a lockout waiting for the day the phone breaks.
                            <span className="text-warning">Ask the site for a new set.</span>
                        ) : null}
                    </div>
                    <ul className="flex flex-col gap-1">
                        {lines.map((line, index) => (
                            <li key={`${line}-${index}`} className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => void copyCode(index)}
                                    className={cn(
                                        "flex-1 rounded-md border border-border px-2 py-1 text-left font-mono text-xs transition-colors hover:bg-card-hover",
                                        codeUsed(line) && "text-muted-foreground line-through"
                                    )}
                                    title={codeUsed(line) ? "Used - copy it anyway" : "Copy and mark used"}
                                >
                                    {codeText(line)}
                                </button>
                                {copied === index ? (
                                    <Check className="size-4 shrink-0 text-success" />
                                ) : (
                                    <Copy className="size-4 shrink-0 text-muted-foreground" />
                                )}
                                {onChange ? (
                                    <Button
                                        type="button"
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label={codeUsed(line) ? "Mark as unused" : "Mark as used"}
                                        title={codeUsed(line) ? "Mark as unused" : "Mark as used"}
                                        onClick={() =>
                                            onChange(
                                                lines
                                                    .map((entry, at) =>
                                                        at === index
                                                            ? withUsed(entry, !codeUsed(entry))
                                                            : entry
                                                    )
                                                    .join("\n")
                                            )
                                        }
                                    >
                                        {codeUsed(line) ? (
                                            <RotateCcw className="size-4 shrink-0" />
                                        ) : (
                                            <Check className="size-4 shrink-0" />
                                        )}
                                    </Button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}

            {onChange ? (
                <>
                    <textarea
                        value={pasting}
                        onChange={(event) => setPasting(event.target.value)}
                        onBlur={() => {
                            const codes = core.readRecoveryCodes(pasting);
                            if (codes.length > 0) take(codes);
                        }}
                        placeholder="Paste the codes here - however the site printed them"
                        rows={2}
                        className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs outline-none focus-visible:border-border-strong"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={core.readRecoveryCodes(pasting).length === 0}
                            onClick={() => take(core.readRecoveryCodes(pasting))}
                        >
                            Add {core.readRecoveryCodes(pasting).length || ""} codes
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => file.current?.click()}
                        >
                            <FileUp className="size-4 shrink-0" />
                            From a file
                        </Button>
                        <input
                            ref={file}
                            type="file"
                            accept=".txt,.csv,text/plain,text/csv"
                            className="hidden"
                            onChange={(event) => {
                                const picked = event.target.files?.[0];
                                event.target.value = "";
                                if (picked) void readFile(picked);
                            }}
                        />
                    </div>
                </>
            ) : null}
        </div>
    );
}

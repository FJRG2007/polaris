"use client";

/**
 * The codes a site hands out for the day the authenticator is gone.
 *
 * They are the most valuable thing in a two-factor setup and the worst kept: a
 * screenshot, a text file in Downloads, a note in an email to yourself. A vault
 * is where they belong, and they belong there behind the same press as a
 * password - which is what they are, so they are covered until somebody asks to
 * see them, and copying one never uncovers the rest.
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
 *
 * A second set arriving is the one moment worth interrupting. Almost every site
 * invalidates the old codes when it issues new ones, so silently appending would
 * leave a list where most entries no longer work and nothing on screen says
 * which - the worst possible state for something only reached for in an
 * emergency. Polaris cannot know which way that site went, so it asks.
 */

import * as core from "@polaris/core";
import { useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff, FileUp, RotateCcw } from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

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

/** What a covered code looks like: the shape of the thing, not the thing. Its
 *  own length rather than a fixed run of dots, so a list still reads as a list
 *  of codes. */
function masked(code: string): string {
    return "•".repeat(Math.min(code.length, 24));
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
    /** Covered until asked for, exactly like the password above it. */
    const [revealed, setRevealed] = useState(false);
    /** Codes waiting on the answer to "do these replace the ones you have?". */
    const [arriving, setArriving] = useState<string[] | null>(null);

    const lines = value.split("\n").filter((line) => line.trim().length > 0);
    const left = lines.filter((line) => !codeUsed(line)).length;

    /** Take a set in, keeping whichever codes the answer says to keep. New ones
     *  land unused whichever way it goes: a fresh set has been used by nobody. */
    const commit = (codes: string[], replace: boolean) => {
        const kept = replace ? [] : lines;
        const existing = new Set(kept.map((line) => codeText(line)));
        onChange?.([...kept, ...codes.filter((code) => !existing.has(code))].join("\n"));
        setPasting("");
        setArriving(null);
    };

    const take = (codes: string[]) => {
        if (codes.length === 0) return;
        // Nothing to replace, so nothing to ask about.
        if (lines.length === 0) commit(codes, false);
        else setArriving(codes);
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
        // Copied whether or not it is on screen: taking a code away is the point,
        // and reading it first is not a step anybody needs.
        await navigator.clipboard.writeText(codeText(line));
        setCopied(index);
        window.setTimeout(() => setCopied(null), 2000);
        // Struck off as it is taken. The only moment anybody could record this
        // is the moment they use one.
        if (!codeUsed(line) && onChange) {
            onChange(
                lines.map((entry, at) => (at === index ? withUsed(entry, true) : entry)).join("\n")
            );
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
                        <span className="flex items-center gap-2">
                            {!readOnly && left === 0 ? (
                                // The sentence that matters: a set with nothing
                                // left is a lockout waiting for the day the
                                // phone breaks.
                                <span className="text-warning">Ask the site for a new set.</span>
                            ) : null}
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                title={revealed ? "Hide the codes" : "Show the codes"}
                                aria-label={revealed ? "Hide the codes" : "Show the codes"}
                                onClick={() => setRevealed((prev) => !prev)}
                            >
                                {revealed ? (
                                    <EyeOff className="size-4 shrink-0" />
                                ) : (
                                    <Eye className="size-4 shrink-0" />
                                )}
                            </Button>
                        </span>
                    </div>
                    <ul className="flex flex-col gap-1">
                        {lines.map((line, index) => (
                            <li key={`${line}-${index}`} className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => void copyCode(index)}
                                    className={cn(
                                        "flex-1 truncate rounded-md border border-border px-2 py-1 text-left font-mono text-xs transition-colors hover:bg-card-hover",
                                        codeUsed(line) && "text-muted-foreground line-through"
                                    )}
                                    title={
                                        codeUsed(line) ? "Used - copy it anyway" : "Copy and mark used"
                                    }
                                >
                                    {revealed ? codeText(line) : masked(codeText(line))}
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
                        onBlur={() => take(core.readRecoveryCodes(pasting))}
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

            {/* Three answers rather than two, because "keep both" is a real one:
                a few sites hand out extra codes without invalidating anything,
                and somebody who knows that should not have to paste twice. */}
            <Dialog open={arriving !== null} onOpenChange={(open) => !open && setArriving(null)}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>
                            Replace the {lines.length} codes you already have?
                        </DialogTitle>
                        <DialogDescription>
                            Most sites cancel the old codes when they hand out a new set, so the
                            ones here would no longer work. Polaris cannot tell which way this site
                            went.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="ghost" onClick={() => setArriving(null)}>
                            Cancel
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={() => commit(arriving ?? [], false)}
                        >
                            Keep both sets
                        </Button>
                        <Button variant="danger" onClick={() => commit(arriving ?? [], true)}>
                            Replace them
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

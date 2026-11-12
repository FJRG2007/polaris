"use client";

/**
 * A rich text field with "Improve" on it: the editor, the wand beside its
 * label, the rewriting effect over it while the new text is written, and the
 * fields the rewrite left to fill listed under it. The one piece every place
 * that wants Improve drops in - a task's description, a comment, a page - so
 * it looks and behaves the same everywhere.
 *
 * The rewrite is handed to `onChange` and `onBlur` both, so a field that saves
 * on blur saves it as if it had been typed. Without Polar for this account the
 * field is the plain editor.
 */

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@polaris/ui";
import { AiRewriting } from "@/components/polar/ai-rewriting";
import { FillInBar } from "@/components/polar/fill-in-bar";
import { usePolarAllowed } from "@/components/polar/polar-allowed";
import { ImproveButton, type ImproveFor } from "@/components/polar/improve-button";
import { RichTextEditor, type RichTextEditorProps } from "@/components/rich-text/rich-text-editor";

export function ImprovableRichText({
    label,
    purpose,
    orgId = null,
    spaceId = null,
    className,
    ...editor
}: RichTextEditorProps & {
    /** The field's heading, drawn with the wand at its end. */
    label?: ReactNode;
    purpose: ImproveFor;
    orgId?: string | null;
    spaceId?: string | null;
}) {
    const allowed = usePolarAllowed();
    // What the editor holds now: the value it was given, then what was typed
    // or rewritten into it. The wand reads this, not the last saved value.
    const [current, setCurrent] = useState(editor.value);
    useEffect(() => setCurrent(editor.value), [editor.value]);
    const [busy, setBusy] = useState(false);
    const [reveal, setReveal] = useState<{ token: number; label: string } | null>(null);
    const canImprove = allowed && !editor.disabled;

    const wand = canImprove ? (
        <ImproveButton
            purpose={purpose}
            orgId={orgId}
            spaceId={spaceId}
            value={current}
            onBusyChange={setBusy}
            onChange={(next) => {
                setCurrent(next);
                editor.onChange?.(next);
                editor.onBlur?.(next);
            }}
        />
    ) : null;

    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            {label !== undefined || wand ? (
                <div className="flex min-w-0 items-center gap-2">
                    <div className="min-w-0 flex-1">{label}</div>
                    {wand}
                </div>
            ) : null}
            <AiRewriting active={busy}>
                <RichTextEditor
                    {...editor}
                    value={current}
                    reveal={reveal}
                    disabled={editor.disabled || busy}
                    onChange={(next) => {
                        setCurrent(next);
                        editor.onChange?.(next);
                    }}
                />
            </AiRewriting>
            {canImprove ? (
                <FillInBar
                    text={current}
                    onReveal={(field) => setReveal({ token: Date.now(), label: field })}
                />
            ) : null}
        </div>
    );
}

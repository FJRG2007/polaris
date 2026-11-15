/**
 * The bare text of a control, put where it can give way.
 *
 * Text written straight into a flex box (a button, a badge) is an anonymous flex
 * item, and `text-overflow` does not apply to one: a label longer than its box
 * runs out of it however the box is styled. A translation is routinely half as
 * long again as the English it replaces, so every label has to survive that - by
 * an ellipsis, with the whole of it in `title` once it is cut (`FitLabel`),
 * rather than by somebody shortening the translation until it fits.
 *
 * Runs of text are kept together in one span: split per child, "Delete " and a
 * name would each truncate on their own and the space between them would be lost
 * at the edge of the first. Elements (icons, nested markup) pass through as they
 * are.
 *
 * The span inherits `white-space` rather than setting it: a control that is
 * nowrap (the default for a button or a badge) gets an ellipsis, and one that
 * opted into wrapping with `whitespace-normal` still wraps.
 */

import { FitLabel } from "./fit-label";
import { Children, isValidElement, type ReactNode } from "react";

export const FIT_TEXT_CLASS = "min-w-0 overflow-hidden text-ellipsis";

export function fitText(children: ReactNode, className = FIT_TEXT_CLASS): ReactNode {
    const parts = Children.toArray(children);
    if (!parts.some((part) => typeof part === "string" || typeof part === "number")) return children;
    const out: ReactNode[] = [];
    let run: string[] = [];
    const flush = () => {
        if (run.length === 0) return;
        const text = run.join("");
        run = [];
        // Whitespace on its own between two icons is not a label.
        if (!text.trim()) {
            out.push(text);
            return;
        }
        out.push(
            <FitLabel key={`fit-${out.length}`} className={className}>
                {text}
            </FitLabel>
        );
    };
    for (const part of parts) {
        if (typeof part === "string" || typeof part === "number") run.push(String(part));
        else {
            flush();
            if (isValidElement(part)) out.push(part);
        }
    }
    flush();
    return out;
}

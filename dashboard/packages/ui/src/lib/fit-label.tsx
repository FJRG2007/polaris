"use client";

/**
 * The span `fitText` puts a control's text in.
 *
 * Its `title` is set when the pointer arrives and only if the text is actually
 * cut: a label that fits needs no tooltip repeating it, and a control that
 * already carries a `title` of its own (a hint, the action it takes) keeps that
 * one rather than having it shadowed by its own label.
 */

import type { PointerEvent, ReactNode } from "react";

export function FitLabel({ className, children }: { className: string; children: ReactNode }) {
    return (
        <span className={className} onPointerEnter={showWhenCut}>
            {children}
        </span>
    );
}

function showWhenCut(event: PointerEvent<HTMLSpanElement>) {
    const label = event.currentTarget;
    if (label.parentElement?.closest("[title]")) return;
    if (label.scrollWidth > label.clientWidth) label.title = (label.textContent ?? "").trim();
    else label.removeAttribute("title");
}

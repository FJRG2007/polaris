"use client";

/**
 * Thin wrapper around GitHub's <relative-time> web component. It renders a
 * human, self-updating relative timestamp ("3 hours ago") with the absolute time
 * on hover. The element is registered lazily in the browser (it extends
 * HTMLElement, which does not exist during SSR), and until it upgrades the
 * absolute date is shown as the fallback, so there is never a blank cell.
 */

import { useDisplayFormat } from "./display-format";
import { createElement, useEffect, type ReactElement } from "react";

export function RelativeTime({
    iso,
    tense = "past"
}: {
    iso: string;
    /** "future" for a moment that has not happened yet ("in 26 days"), which the
     *  element will not phrase correctly if it is told to expect a past one. */
    tense?: "past" | "future";
}): ReactElement {
    const format = useDisplayFormat();
    useEffect(() => {
        void import("@github/relative-time-element");
    }, []);

    const absolute = format.dateTime(iso);
    return createElement(
        "relative-time",
        { datetime: iso, tense, title: absolute },
        absolute
    );
}

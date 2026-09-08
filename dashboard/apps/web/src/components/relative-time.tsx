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
    tense = "past",
    formatStyle,
    threshold,
    className
}: {
    iso: string;
    /** "future" for a moment that has not happened yet ("in 26 days"), which the
     *  element will not phrase correctly if it is told to expect a past one. */
    tense?: "past" | "future";
    /**
     * How much room the phrase may take.
     *
     * "long" is the default and is what a card or a table cell wants - "3 hours
     * ago". "narrow" is for a column that has none: "3h ago", which is the same
     * fact in a third of the width, and is what a list of conversations needs
     * beside a subject it is already truncating.
     */
    formatStyle?: "long" | "short" | "narrow";
    /**
     * When it stops being relative and becomes a date.
     *
     * An ISO 8601 duration. Past it the element prints the absolute date
     * instead, because "14 months ago" is a worse answer than the month it
     * happened in. The element's own default is 30 days.
     */
    threshold?: string;
    className?: string;
}): ReactElement {
    const format = useDisplayFormat();
    useEffect(() => {
        void import("@github/relative-time-element");
    }, []);

    const absolute = format.dateTime(iso);
    return createElement(
        "relative-time",
        {
            datetime: iso,
            tense,
            // Only when asked for: an attribute set to undefined is not written,
            // so everything already using this keeps the element's own defaults.
            ...(formatStyle ? { formatStyle } : {}),
            ...(threshold ? { threshold } : {}),
            ...(className ? { className } : {}),
            title: absolute
        },
        absolute
    );
}

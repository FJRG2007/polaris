"use client";

/**
 * Thin wrapper around GitHub's <relative-time> web component. It renders a
 * human, self-updating relative timestamp ("3 hours ago") with the absolute time
 * on hover. The element is registered lazily in the browser (it extends
 * HTMLElement, which does not exist during SSR), and until it upgrades the
 * absolute date is shown as the fallback, so there is never a blank cell.
 */

import { createElement, useEffect, type ReactElement } from "react";

export function RelativeTime({ iso }: { iso: string }): ReactElement {
    useEffect(() => {
        void import("@github/relative-time-element");
    }, []);

    const absolute = new Date(iso).toLocaleString();
    return createElement(
        "relative-time",
        { datetime: iso, tense: "past", title: absolute },
        absolute
    );
}

"use client";

/**
 * Keep a scrolling region on its newest content - a log still streaming, a
 * conversation still being polled - without taking the scrollbar away from
 * whoever is reading with it.
 *
 * The rule every console follows: new output goes to the bottom while the reader
 * is at the bottom, and stops moving the moment they scroll up to read something
 * that has already gone past. Scrolling back down is what turns following on
 * again, so nothing has to be switched off and on by hand - the position of the
 * scrollbar is the setting.
 */

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";

/**
 * How close to the end still counts as reading the live end. A line of slack, so
 * a fractional scroll position or a row that grew by a pixel is not mistaken for
 * somebody having scrolled away.
 */
const AT_BOTTOM = 24;

export interface FollowBottom<T extends HTMLElement> {
    /** Goes on the scrolling element itself. */
    ref: RefObject<T | null>;
    /** Bind to that element's `onScroll`: it is what notices the reader moving. */
    onScroll: () => void;
    /** Put the newest content back on screen and follow it again - for a region
     *  that swapped to different content entirely, where the position somebody
     *  held in the last one means nothing. */
    stick: () => void;
}

/**
 * @param content Whatever changing value means "there is new output" - the log
 *                text, the number of messages. Following happens when it changes.
 * @param enabled Off for a region that should never move on its own.
 */
export function useFollowBottom<T extends HTMLElement>(content: unknown, enabled = true): FollowBottom<T> {
    const ref = useRef<T>(null);
    const following = useRef(true);

    const onScroll = useCallback(() => {
        const element = ref.current;
        if (!element) return;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM;
    }, []);

    const stick = useCallback(() => {
        following.current = true;
        const element = ref.current;
        if (element) element.scrollTop = element.scrollHeight;
    }, []);

    useEffect(() => {
        const element = ref.current;
        if (!element || !enabled || !following.current) return;
        element.scrollTop = element.scrollHeight;
    }, [content, enabled]);

    // One object for the life of the region: callers put it in effect
    // dependencies, and a new one on every render would make those effects run on
    // every render - which for `stick` would mean never letting go of the bottom.
    return useMemo(() => ({ ref, onScroll, stick }), [onScroll, stick]);
}

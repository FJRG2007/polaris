"use client";

/**
 * The calendar on a phone: which views it offers, which one it opens on, and
 * how far a step or a swipe moves it.
 *
 * Laid out the way Google Calendar's phone app is (Schedule, Day, 3 days, Week,
 * Month - https://support.google.com/calendar/answer/37189): the schedule is
 * where a phone opens until somebody picks another view, and the pick is kept
 * on this device only. The account's own `view` setting is the desktop's, so
 * looking at a month on the phone does not change what the laptop opens on.
 *
 * The rules are plain functions over plain values so the tests drive them
 * without a DOM; the storage and the media query are thin wrappers around them.
 */

import * as time from "./time";
import { PHONE_QUERY } from "./swipe-step";
import { useSyncExternalStore } from "react";
import type { CalendarViewName } from "../lib/preferences";

/** The views a phone offers, in the order its picker lists them. */
export const PHONE_VIEWS = [
    "list",
    "day",
    "days",
    "week",
    "month"
] as const satisfies readonly CalendarViewName[];
export type PhoneViewName = (typeof PHONE_VIEWS)[number];

/** A phone opens on the schedule until somebody picks another view. */
export const DEFAULT_PHONE_VIEW: PhoneViewName = "list";

/** The phone's custom view is three days wide: a week does not fit a phone's
 *  columns, and three is what Google's and Outlook's phone apps draw. */
export const PHONE_DAYS = 3;

/** Where this device keeps the view it was left on. */
export const PHONE_VIEW_KEY = "polaris.calendar.phone-view";

export function isPhoneView(value: unknown): value is PhoneViewName {
    return typeof value === "string" && (PHONE_VIEWS as readonly string[]).includes(value);
}

/**
 * The view a phone opens on: the one the address names, when it names one;
 * else the one this device was left on; else the schedule. A stored value that
 * is not a phone view (an old build's, or something else's) is ignored.
 */
export function openingPhoneView(
    routed: CalendarViewName | null,
    stored: unknown
): CalendarViewName {
    if (routed) return routed;
    return isPhoneView(stored) ? stored : DEFAULT_PHONE_VIEW;
}

/** How many days the custom view spans: three on a phone, the setting elsewhere. */
export function daysFor(phone: boolean, customDays: number): number {
    return phone ? PHONE_DAYS : customDays;
}

/** The anchor after one step or swipe of `direction` on a phone. */
export function phoneStep(
    view: CalendarViewName,
    anchor: time.DayString,
    direction: 1 | -1
): time.DayString {
    return time.stepAnchor(view, anchor, direction, PHONE_DAYS);
}

/** The view this device was left on; null when nothing is stored or storage is
 *  unavailable (a private window, blocked site data). */
export function readPhoneView(): string | null {
    try {
        return window.localStorage.getItem(PHONE_VIEW_KEY);
    } catch {
        return null;
    }
}

export function writePhoneView(view: CalendarViewName): void {
    try {
        window.localStorage.setItem(PHONE_VIEW_KEY, view);
    } catch {
        // Not kept: the next visit opens on the schedule again.
    }
}

/** Whether the screen is phone-sized right now, outside React. */
export function phoneNow(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(PHONE_QUERY).matches
        : false;
}

function subscribe(change: () => void): () => void {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
    const query = window.matchMedia(PHONE_QUERY);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
}

/** Whether the screen is phone-sized, following a rotation or a resize. */
export function usePhone(): boolean {
    return useSyncExternalStore(subscribe, phoneNow, () => false);
}

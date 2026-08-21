/**
 * The colour beside each thing an account can choose to appear as.
 *
 * Its own module rather than a constant in the picker, because the schedule
 * screen draws the same four dots for the same four words and two tables would
 * be two things to keep in step. No `"use client"` here on purpose: a value
 * exported from a client module arrives at a server component as a reference
 * rather than as itself.
 *
 * Not the same map as the one an avatar wears, which is keyed by what is
 * actually drawn and so has no `auto` and no invisible - those are choices, not
 * states.
 */

import type { PresenceChoice } from "@polaris/core";

export const PRESENCE_CHOICE_DOTS: Record<PresenceChoice, string> = {
    auto: "bg-success",
    busy: "bg-danger",
    away: "bg-warning",
    invisible: "bg-border-strong"
};

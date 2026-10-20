/**
 * Marking a Polar answer good or bad: the shapes the answer's row, the route
 * and the administrator's list share. Safe on both sides.
 */

import { z } from "zod";

/** A message id as the chat writes them: the AI SDK's, or a UUID. */
export const polarMessageIdSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/);

export const POLAR_RATINGS = ["good", "bad"] as const;
export type PolarRating = (typeof POLAR_RATINGS)[number];

/** What a bad answer can be said to have got wrong, in the order offered. */
export const POLAR_BAD_REASONS = [
    "incorrect",
    "instructions",
    "incomplete",
    "style",
    "slow",
    "unsafe",
    "other"
] as const;
export type PolarBadReason = (typeof POLAR_BAD_REASONS)[number];

export const POLAR_FEEDBACK_NOTE_MAX = 1000;

/** The body of a mark: a rating, or null to take it back. Reasons and a note
 *  belong to a bad one only. */
export const polarFeedbackBodySchema = z
    .object({
        rating: z.enum(POLAR_RATINGS).nullable(),
        reasons: z.array(z.enum(POLAR_BAD_REASONS)).max(POLAR_BAD_REASONS.length).default([]),
        note: z.string().trim().max(POLAR_FEEDBACK_NOTE_MAX).nullish()
    })
    .transform((body) => ({
        rating: body.rating,
        reasons: body.rating === "bad" ? [...new Set(body.reasons)] : [],
        note: body.rating === "bad" && body.note ? body.note : null
    }));
export type PolarFeedbackBody = z.infer<typeof polarFeedbackBodySchema>;

/** One mark as the administrator's list shows it. */
export interface PolarFeedbackRow {
    id: string;
    rating: PolarRating;
    reasons: PolarBadReason[];
    note: string | null;
    model: string | null;
    userId: string;
    name: string;
    at: string;
}

export interface PolarFeedbackSummary {
    /** Marks of the last 30 days. */
    good: number;
    bad: number;
    /** The newest bad marks, with what was said. */
    recent: PolarFeedbackRow[];
}

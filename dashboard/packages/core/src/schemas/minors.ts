/**
 * What the family screens and actions accept: creating a minor's account,
 * a guardian's overrides, holding back a stage move, adding a guardian and
 * moving a stage by hand. Shared so the form validates against exactly what
 * the server enforces.
 *
 * Anything that depends on "today" (a birth month in the future, a delay) is
 * checked against the clock when the value is parsed. The pure rules live in
 * `minors.ts` and take the day explicitly.
 */

import { z } from "zod";
import { emailField, passwordField, personNameField, usernameField } from "./auth.js";
import { passwordMatchesIdentity, IDENTITY_PASSWORD_MESSAGE } from "../password-safety.js";
import * as minors from "../minors.js";

const BIRTH_MONTH_MESSAGES = {
    invalid: "Pick a month and a year",
    future: "That month has not happened yet",
    tooOld: "That is more than 120 years ago"
} as const;

/** A birth month (`YYYY-MM`) somebody can have today. Required (D4): month and
 *  year only, never the day. */
export const birthMonthField = z
    .string()
    .trim()
    .superRefine((value, ctx) => {
        const issue = minors.birthMonthIssue(value, minors.calendarDateIn(new Date()));
        if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: BIRTH_MONTH_MESSAGES[issue] });
    });

/** A minor's birth month: one that is somebody's, and under the majority age. */
export const minorBirthMonthField = birthMonthField.superRefine((value, ctx) => {
    const today = minors.calendarDateIn(new Date());
    if (minors.birthMonthIssue(value, today)) return;
    if (minors.ageOn(value, today) >= minors.MAJORITY_AGE) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Already ${minors.MAJORITY_AGE} or older` });
    }
});

export const minorStageField = z.enum(minors.MINOR_STAGES);

const userIdField = z.string().uuid("Pick somebody");

/** A calendar day, `YYYY-MM-DD`, that exists. */
export const calendarDateField = z
    .string()
    .trim()
    .refine((value) => minors.parseCalendarDate(value) !== null, "Pick a day");

/**
 * A guardian creating a child's account. Email is optional (a young child has
 * none; the account gets a placeholder and signs in by username). The password
 * is the guardian's to set and may not be built from the child's name.
 */
export const createMinorSchema = z
    .object({
        name: personNameField,
        username: usernameField,
        password: passwordField,
        birthMonth: minorBirthMonthField,
        email: z.union([z.literal("").transform(() => undefined), emailField]).optional()
    })
    .superRefine((value, ctx) => {
        if (passwordMatchesIdentity(value.password, [value.name, value.username, value.email])) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["password"], message: IDENTITY_PASSWORD_MESSAGE });
        }
    });

export type CreateMinorInput = z.infer<typeof createMinorSchema>;

const capabilityField = z
    .enum(minors.MINOR_CAPABILITIES as [minors.MinorCapability, ...minors.MinorCapability[]])
    .refine((key) => !minors.isFloorCapability(key), "Nobody can turn this on for a minor");

/**
 * A guardian's overrides, the whole list at once: a key absent from it follows
 * the stage. Floor keys are refused here, so a request to loosen one never
 * reaches the server's own check.
 */
export const setMinorOverridesSchema = z.object({
    minorId: userIdField,
    overrides: z
        .array(z.object({ key: capabilityField, effect: z.enum(["allow", "deny"]) }))
        .max(minors.MINOR_CAPABILITIES.length)
        .superRefine((overrides, ctx) => {
            const seen = new Set<string>();
            overrides.forEach((override, index) => {
                if (seen.has(override.key)) {
                    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "key"], message: "Listed twice" });
                }
                seen.add(override.key);
            });
        })
});

export type SetMinorOverridesInput = z.infer<typeof setMinorOverridesSchema>;

/** Holding back an automatic move. Whether the day is allowed (D5) is
 *  `delayRefusal`, which needs the stored due date. */
export const delayStageSchema = z.object({
    minorId: userIdField,
    until: calendarDateField,
    reason: z.string().trim().max(280, "At most 280 characters").optional()
});

export type DelayStageInput = z.infer<typeof delayStageSchema>;

/** Adding a guardian, by a guardian (an invite) or by an administrator (D7). */
export const assignGuardianSchema = z
    .object({
        minorId: userIdField,
        guardianId: userIdField,
        role: z.enum(["primary", "secondary"]).default("secondary")
    })
    .refine((value) => value.minorId !== value.guardianId, {
        path: ["guardianId"],
        message: "Somebody cannot be their own guardian"
    });

export type AssignGuardianInput = z.infer<typeof assignGuardianSchema>;

/** Moving a stage by hand: a guardian's "move up now", or an administrator's
 *  correction (D7). Which moves are allowed is decided against the stored row. */
export const setMinorStageSchema = z.object({
    minorId: userIdField,
    stage: minorStageField,
    reason: z.string().trim().max(280, "At most 280 characters").optional()
});

export type SetMinorStageInput = z.infer<typeof setMinorStageSchema>;

/** The instance's digital consent age (D2): a whole number in the range EU
 *  member states use, 14 when never set. */
export const digitalConsentAgeField = z
    .number()
    .int("A whole number of years")
    .min(minors.MIN_DIGITAL_CONSENT_AGE, `At least ${minors.MIN_DIGITAL_CONSENT_AGE}`)
    .max(minors.MAX_DIGITAL_CONSENT_AGE, `At most ${minors.MAX_DIGITAL_CONSENT_AGE}`)
    .default(minors.DEFAULT_DIGITAL_CONSENT_AGE);

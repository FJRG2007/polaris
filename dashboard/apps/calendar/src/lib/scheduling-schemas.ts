/**
 * What the booking, proposal, room, free/busy and answer screens send, checked
 * the same way on both sides: the form checks it as it is typed, the action
 * checks it again before anything runs.
 *
 * A refinement's message is a catalog key (`booking.validation.*` and the like)
 * so either side shows it in the reader's language; `issueKey` picks it out.
 *
 * Pure: shared by screens and server.
 */

import { z } from "zod";
import { availabilitySchema } from "../engine/schemas";
import { cleanText, colorSchema, isKnownZone, nameSchema, uuidSchema } from "./schemas";

/** Normalize an address the way every calendar screen stores it. */
export function normalizeAddress(value: string): string {
    return value.trim().replace(/^mailto:/i, "").toLowerCase();
}

/** An email address: trimmed, lowercased, then checked. */
export const emailSchema = z
    .string()
    .transform(normalizeAddress)
    .pipe(z.string().min(1, "booking.validation.emailNeeded").max(320).email("booking.validation.email"));

/** A person's name as they typed it: cleaned, each word capitalized. */
export function normalizePersonName(value: string): string {
    return cleanText(value)
        .split(" ")
        .map((word) => (word ? word[0]!.toLocaleUpperCase() + word.slice(1) : word))
        .join(" ");
}

export const personNameSchema = z
    .string()
    .transform(normalizePersonName)
    .pipe(z.string().min(1, "booking.validation.nameNeeded").max(120));

/** A zone Intl knows; required here, since a page has to say where its hours are. */
export const requiredZoneSchema = z
    .string()
    .trim()
    .max(64)
    .refine((zone) => zone !== "" && isKnownZone(zone), "bookingPage.validation.zone");

/** Free text of one paragraph or more, trimmed, bounded. */
const prose = (max: number) =>
    z
        .string()
        .max(max)
        .transform((value) => value.trim());

/** A one-line text that may be empty. */
const line = (max: number) =>
    z
        .string()
        .transform(cleanText)
        .pipe(z.string().max(max));

/** What a booking page's address ends in. */
export const slugSchema = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/, "bookingPage.validation.slugForm"));

// ---------------------------------------------------------------- booking pages

export const QUESTION_KINDS = ["short", "long", "choice"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const questionSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9]{4,16}$/),
        label: z
            .string()
            .transform(cleanText)
            .pipe(z.string().min(1, "bookingPage.validation.questionLabel").max(200)),
        kind: z.enum(QUESTION_KINDS),
        required: z.boolean(),
        options: z.array(z.string().transform(cleanText).pipe(z.string().min(1).max(100))).max(20).default([])
    })
    .superRefine((question, context) => {
        if (question.kind === "choice" && question.options.length < 2) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "bookingPage.validation.optionsNeeded" });
        }
        if (new Set(question.options).size !== question.options.length) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "bookingPage.validation.optionTwice" });
        }
    });

export type BookingQuestion = z.infer<typeof questionSchema>;

export const VISIBILITIES = ["link", "public"] as const;

export const bookingPageInputSchema = z
    .object({
        title: nameSchema,
        slug: slugSchema.optional(),
        description: prose(4000),
        location: line(500),
        visibility: z.enum(VISIBILITIES),
        calendarId: uuidSchema,
        conflictIds: z.array(uuidSchema).max(20),
        durationMinutes: z.number().int().min(5).max(720),
        slotMinutes: z.number().int().min(5).max(720),
        bufferBefore: z.number().int().min(0).max(240),
        bufferAfter: z.number().int().min(0).max(240),
        noticeMinutes: z.number().int().min(0).max(60 * 24 * 60),
        maxPerDay: z.number().int().min(1).max(100).nullable(),
        horizonDays: z.number().int().min(1).max(365),
        timezone: requiredZoneSchema,
        availability: availabilitySchema,
        questions: z.array(questionSchema).max(10),
        meetingLink: z.boolean(),
        enabled: z.boolean()
    })
    .superRefine((page, context) => {
        if (new Set(page.questions.map((question) => question.id)).size !== page.questions.length) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["questions"], message: "bookingPage.validation.questionTwice" });
        }
        const open = Object.values(page.availability.weekly).some((ranges) => ranges.length > 0);
        if (!open) context.addIssue({ code: z.ZodIssueCode.custom, path: ["availability"], message: "bookingPage.validation.noHours" });
    });

export type BookingPageInput = z.infer<typeof bookingPageInputSchema>;

/** The answers a page's questions ask for: required ones filled, a choice one
 *  of the offered options, nothing that is not a question. */
export function answersSchemaFor(questions: readonly BookingQuestion[]) {
    return z.record(z.string(), z.string().max(4000)).transform((raw, context) => {
        const answers: Record<string, string> = {};
        for (const question of questions) {
            const value = question.kind === "long" ? (raw[question.id] ?? "").trim() : cleanText(raw[question.id] ?? "");
            if (!value) {
                if (question.required) {
                    context.addIssue({ code: z.ZodIssueCode.custom, path: [question.id], message: "booking.validation.answerNeeded" });
                }
                continue;
            }
            if (question.kind === "choice" && !question.options.includes(value)) {
                context.addIssue({ code: z.ZodIssueCode.custom, path: [question.id], message: "booking.validation.choice" });
                continue;
            }
            answers[question.id] = value.slice(0, question.kind === "long" ? 4000 : 500);
        }
        return answers;
    });
}

/** What a visitor sends to hold a slot. The answers are checked against the
 *  page's own questions separately (`answersSchemaFor`). */
export const bookingRequestSchema = z.object({
    slug: slugSchema,
    start: z.string().datetime({ offset: true }),
    name: personNameSchema,
    email: emailSchema,
    note: prose(2000),
    answers: z.record(z.string(), z.string().max(4000)),
    timezone: requiredZoneSchema
});

export type BookingRequest = z.infer<typeof bookingRequestSchema>;

/** A token handed out in a link: confirm, manage, answer, vote. */
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/);

// ---------------------------------------------------------------- proposals

export const proposalParticipantSchema = z.object({
    email: emailSchema,
    name: z.string().transform(cleanText).pipe(z.string().max(120)),
    required: z.boolean()
});

export const proposalInputSchema = z
    .object({
        title: nameSchema,
        description: prose(4000),
        location: line(500),
        durationMinutes: z.number().int().min(5).max(24 * 60),
        timezone: requiredZoneSchema,
        notify: z.boolean(),
        participants: z.array(proposalParticipantSchema).min(1, "proposals.validation.noParticipants").max(50),
        dates: z.array(z.string().datetime({ offset: true })).min(1, "proposals.validation.noDates").max(30)
    })
    .superRefine((proposal, context) => {
        const emails = proposal.participants.map((participant) => participant.email);
        if (new Set(emails).size !== emails.length) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["participants"], message: "proposals.validation.invitedTwice" });
        }
        const starts = proposal.dates.map((date) => new Date(date).getTime());
        if (new Set(starts).size !== starts.length) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["dates"], message: "proposals.validation.dateTwice" });
        }
    });

export type ProposalInput = z.infer<typeof proposalInputSchema>;

export const VOTES = ["yes", "maybe", "no"] as const;
export type Vote = (typeof VOTES)[number];

export const voteInputSchema = z.object({
    token: tokenSchema,
    votes: z.record(uuidSchema, z.enum(VOTES)).refine((votes) => Object.keys(votes).length <= 30)
});

// ---------------------------------------------------------------- rooms

export const roomInputSchema = z.object({
    name: nameSchema,
    type: z.enum(["room", "equipment"]),
    capacity: z.number().int().min(1).max(100_000).nullable(),
    building: line(120),
    floor: line(60),
    features: z
        .array(z.string().transform(cleanText).pipe(z.string().min(1).max(60)))
        .max(20)
        .transform((list) => [...new Set(list)]),
    color: colorSchema,
    description: prose(2000)
});

export type RoomInput = z.infer<typeof roomInputSchema>;

// ---------------------------------------------------------------- free/busy

/** The widest window free/busy answers: two months of a find-a-time grid. */
export const FREEBUSY_MAX_DAYS = 62;

/** People one free/busy question may name. */
export const FREEBUSY_MAX_PEOPLE = 30;

export const freeBusyRequestSchema = z
    .object({
        emails: z.array(emailSchema).max(FREEBUSY_MAX_PEOPLE).default([]),
        userIds: z.array(uuidSchema).max(FREEBUSY_MAX_PEOPLE).default([]),
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        zone: requiredZoneSchema,
        durationMinutes: z.number().int().min(5).max(24 * 60).optional()
    })
    .refine((input) => input.emails.length + input.userIds.length > 0 && input.emails.length + input.userIds.length <= FREEBUSY_MAX_PEOPLE)
    .refine((input) => {
        const span = new Date(input.to).getTime() - new Date(input.from).getTime();
        return span > 0 && span <= FREEBUSY_MAX_DAYS * 86_400_000;
    });

export type FreeBusyRequest = z.infer<typeof freeBusyRequestSchema>;

// ---------------------------------------------------------------- answers

export const rsvpInputSchema = z.object({
    token: tokenSchema,
    partstat: z.enum(["ACCEPTED", "TENTATIVE", "DECLINED"]),
    recurrenceKey: z.string().max(40).nullable()
});

/** The catalog key a refused value carries, when it carries one of ours. */
export function issueKey(issues: readonly { message: string }[]): string | null {
    const message = issues[0]?.message ?? "";
    return /^(booking|bookingPage|proposals|rooms|vote|rsvp|freeBusy)\.validation\.[A-Za-z]+$/.test(message) ? message : null;
}

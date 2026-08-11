/**
 * The one thing an operator writes into the public pages: how to reach them.
 *
 * An address or a page, because both are real answers - a person running this
 * for their household gives an email, an organisation points at the contact form
 * it already has. Neither is guessable from anything else on the deployment, so
 * it is asked for rather than derived, and left out entirely when unset instead
 * of printed as an empty line under a heading.
 *
 * Normalized before it is checked, on both sides of the wire, so the same string
 * is stored whichever field it was typed into: an address is lowercased (nobody
 * means a different mailbox by writing it in capitals) and a page keeps its case,
 * since a path can be case-sensitive.
 */

import { z } from "zod";

/** Long enough for a real address or a contact URL, short enough to stay a line. */
export const MAX_LEGAL_CONTACT_LENGTH = 200;

/** The stored form of whatever was typed: trimmed, and lowercased when it is an
 *  address. Exported so the field and the action normalize identically. */
export function normalizeLegalContact(value: string): string {
    const trimmed = value.trim();
    return /^[^\s@]+@[^\s@]+$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** An email address, an https page, or empty - which means "publish no contact". */
export const legalContactSchema = z
    .string()
    .max(MAX_LEGAL_CONTACT_LENGTH, `At most ${MAX_LEGAL_CONTACT_LENGTH} characters`)
    .transform(normalizeLegalContact)
    .refine(
        (value) =>
            value === "" ||
            z.string().email().safeParse(value).success ||
            (z.string().url().safeParse(value).success && value.startsWith("https://")),
        "Enter an email address or an https link"
    );

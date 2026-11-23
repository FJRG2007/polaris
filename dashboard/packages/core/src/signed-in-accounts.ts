/**
 * Telling, while somebody types an identifier on a sign-in screen, whether it
 * names an account this device is already signed in to.
 *
 * Only ever compared against the device's own list - the accounts whose
 * sessions it already holds, with the email, username and verified phone each
 * of them carries. It never asks anybody whether an identifier exists, so it
 * cannot become a way to find out who has an account.
 *
 * Pure and client-safe: every client that adds an account (the dashboard, and
 * the apps that show its sign-in screen) runs this same pair.
 */

import { toE164, type PhoneCountry } from "./phone.js";

/** Digits with the separators people type, and nothing else: a phone number
 *  typed without its country code. A username can look like this too. */
export const NATIONAL_PHONE_NUMBER = /^[\d\s().-]{6,20}$/;

/** What identifies one account the device holds, as stored. */
export interface SignedInIdentity {
    readonly email: string;
    readonly username?: string | null;
    /** The account's verified phone number, in any stored spelling. */
    readonly phone?: string | null;
    /** Every verified number on the account, when it holds several. */
    readonly phones?: readonly string[];
}

/** A typed identifier in each form an account could be stored under. */
export interface SignInIdentifierForms {
    readonly email: string | null;
    readonly username: string | null;
    /** E.164, when the text reads as a phone number. */
    readonly phone: string | null;
}

const NONE: SignInIdentifierForms = { email: null, username: null, phone: null };

/**
 * Read a typed identifier the way the sign-in reads it: trimmed and lowercased,
 * an address when it has an `@`, a phone number in international form when it
 * starts with `+`, and otherwise a username - which, all digits, may also be a
 * national phone number read in `country`.
 */
export function signInIdentifierForms(
    typed: string,
    country?: PhoneCountry | null
): SignInIdentifierForms {
    const value = typed.trim().toLowerCase();
    if (!value) return NONE;
    if (value.includes("@")) return { ...NONE, email: value };
    if (value.startsWith("+")) return { ...NONE, phone: toE164(value) };
    const phone = country && NATIONAL_PHONE_NUMBER.test(value) ? toE164(value, country) : null;
    return { ...NONE, username: value, phone };
}

function storedPhone(phone: string | null | undefined): string | null {
    const value = phone?.trim();
    return value ? (toE164(value) ?? value.replace(/[\s().-]/g, "")) : null;
}

/**
 * The account among `accounts` that `typed` names, or null. An email or a
 * username matches regardless of case; a phone number matches however either
 * side was spelled.
 */
export function signedInAccountFor<T extends SignedInIdentity>(
    typed: string,
    accounts: readonly T[],
    country?: PhoneCountry | null
): T | null {
    const forms = signInIdentifierForms(typed, country);
    if (!forms.email && !forms.username && !forms.phone) return null;
    for (const account of accounts) {
        if (forms.email && account.email.trim().toLowerCase() === forms.email) return account;
        if (forms.username && account.username?.trim().toLowerCase() === forms.username) {
            return account;
        }
        if (forms.phone && storedPhone(account.phone) === forms.phone) return account;
        if (forms.phone && account.phones?.some((phone) => storedPhone(phone) === forms.phone)) return account;
    }
    return null;
}

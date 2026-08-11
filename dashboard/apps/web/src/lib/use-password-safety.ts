"use client";

/**
 * The two things wrong with a password that its length cannot tell you.
 *
 * A password can satisfy every rule a form states and still be worthless: the one
 * already sitting in a credential-stuffing list, and the one built out of the
 * account it protects - "Fjrg2007" for fjrg2007 is one guess to anyone who knows
 * the address. Both refusals belong on every screen where somebody chooses a
 * password, so they are one hook rather than a pair of effects copied into each
 * of them.
 *
 * The corpus is asked as the value is typed, debounced, with the in-flight
 * request abandoned the moment it changes - and it never sees the password, only
 * the first five characters of its hash. It fails open: an outage at somebody
 * else's API must never be the reason a person cannot make an account, and the
 * server asks the same question again on submit anyway.
 *
 * The identity rule is pure and immediate, because everything it compares against
 * is already in the form.
 */

import { useEffect, useState } from "react";
import { passwordIsBreached } from "@/lib/pwned-passwords";
import { BREACHED_PASSWORD_MESSAGE, IDENTITY_PASSWORD_MESSAGE, passwordMatchesIdentity } from "@polaris/core";

/** Long enough that the corpus is not asked about every keystroke. */
const DEBOUNCE_MS = 500;

/** The shortest password worth asking about; every form here refuses anything
 *  under 10 on its own. */
const MIN_PASSWORD = 10;

/**
 * Why this password cannot be used, or null.
 *
 * `identity` is whatever the account is known by on this screen - its name, its
 * username, its address - and nulls in it are ignored, so a form that does not
 * know one of them can pass it anyway.
 */
export function usePasswordSafety(
    password: string,
    identity: readonly (string | null | undefined)[]
): string | null {
    const [breached, setBreached] = useState(false);

    useEffect(() => {
        if (password.length < MIN_PASSWORD) {
            setBreached(false);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void passwordIsBreached(password, controller.signal).then((found) => {
                if (!controller.signal.aborted) setBreached(found);
            });
        }, DEBOUNCE_MS);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [password]);

    if (password.length === 0) return null;
    if (passwordMatchesIdentity(password, identity)) return IDENTITY_PASSWORD_MESSAGE;
    return breached ? BREACHED_PASSWORD_MESSAGE : null;
}

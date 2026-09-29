/**
 * The words the shared schemas in `@polaris/core` refuse a value with, in the
 * reader's language.
 *
 * Those schemas run on the client and on the server and have no reader to ask,
 * and several areas share them (an email field, a username, a password), so
 * their messages stay the English source. They are translated where they are
 * shown: a form or an action hands the issue's message here, and a message this
 * table knows comes back in the reader's language. Anything else - a message an
 * area wrote itself - comes back as it was.
 *
 * Pure and catalog-free, so a client component and a server action both use it
 * with whatever translator they already hold over `validation`.
 */

import * as core from "@polaris/core";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type ValidationKey = NamespaceKey<"validation">;

/** Exact messages, by the words core writes them in. */
const EXACT: ReadonlyMap<string, ValidationKey> = new Map<string, ValidationKey>([
    ["Email is required", "emailRequired"],
    ["Enter a valid email", "emailInvalid"],
    ["Name is required", "nameRequired"],
    ["Display name is required", "displayNameRequired"],
    ["Email or username is required", "identifierRequired"],
    ["Password is required", "passwordRequired"],
    ["Setup token is required", "setupTokenRequired"],
    ["Too long", "tooLong"],
    ["Use letters, numbers, - or _", "usernameCharacters"],
    [core.RESERVED_USERNAME_MESSAGE, "usernameReserved"],
    [core.UNPRINTABLE_NAME_MESSAGE, "nameUnprintable"],
    [core.EMOJI_NAME_MESSAGE, "nameEmoji"],
    [core.BROKEN_TEXT_MESSAGE, "nameBroken"],
    [core.IDENTITY_PASSWORD_MESSAGE, "passwordIdentity"],
    [core.BREACHED_PASSWORD_MESSAGE, "passwordBreached"],
    ["Enter your invitation code", "inviteCodeRequired"],
    ["That code is not the right length", "inviteCodeLength"],
    [core.INVITE_REFUSALS.unavailable, "inviteUnavailable"],
    [core.INVITE_REFUSALS.location, "inviteLocation"],
    [core.INVITE_REFUSALS.password, "invitePassword"],
    [core.INVITE_REFUSALS.throttled, "inviteThrottled"]
]);

/** Messages with a length in them. */
const COUNTED: readonly (readonly [RegExp, ValidationKey])[] = [
    [/^At least (\d+) characters$/, "atLeast"],
    [/^At most (\d+) characters$/, "atMost"],
    [/^Use at least (\d+) characters$/, "useAtLeast"]
];

/** Every message the table knows, for the test that holds English to core's words. */
export const KNOWN_VALIDATION_MESSAGES: readonly string[] = [...EXACT.keys()];

/**
 * A core schema's message in the reader's language, or the message itself when
 * it is not one of core's. Undefined stays undefined, so a form's
 * `error(field)` can be passed straight through.
 */
export function validationMessage(t: NamespaceTranslator<"validation">, message: string): string;
export function validationMessage(t: NamespaceTranslator<"validation">, message: string | undefined): string | undefined;
export function validationMessage(t: NamespaceTranslator<"validation">, message: string | undefined): string | undefined {
    if (message === undefined) return undefined;
    const key = EXACT.get(message);
    if (key) return t(key);
    for (const [pattern, counted] of COUNTED) {
        const match = pattern.exec(message);
        if (match) return t(counted, { count: Number(match[1]) });
    }
    return message;
}

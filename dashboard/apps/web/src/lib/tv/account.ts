/**
 * Who a connected TV belongs to, as the TV is told: the full name for its
 * Polaris screen, the first name its home greeting says ("Good afternoon,
 * Sam"), and the language the account reads Polaris in, which the TV follows
 * unless somebody picked one on the TV itself.
 *
 * Built through a schema so the shape the TV parses is the shape that leaves:
 * a stored locale Polaris no longer has, or a name with nothing in it, goes out
 * as null rather than as something the TV would have to second-guess.
 */

import { z } from "zod";
import { isLocale } from "@polaris/core";

/** Longest name a greeting carries; the line it sits on is one row of a TV. */
const FIRST_NAME_MAX = 40;

/** A name that is only control characters or spaces is no name. */
function cleaned(value: string | null | undefined): string {
    return (value ?? "")
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export const tvAccountSchema = z.object({
    name: z.string(),
    firstName: z
        .string()
        .min(1)
        .refine((value) => Array.from(value).length <= FIRST_NAME_MAX)
        .nullable(),
    locale: z
        .string()
        .refine((value) => isLocale(value))
        .nullable()
});

export type TvAccount = z.infer<typeof tvAccountSchema>;

/** The account a TV is shown, from its user row. */
export function tvAccount(user: {
    readonly name: string | null;
    readonly firstName?: string | null;
    readonly locale?: string | null;
}): TvAccount {
    const name = cleaned(user.name);
    const first = cleaned(user.firstName) || name.split(" ")[0] || "";
    return tvAccountSchema.parse({
        name: user.name ?? "",
        firstName: first ? Array.from(first).slice(0, FIRST_NAME_MAX).join("") : null,
        locale: isLocale(user.locale) ? user.locale : null
    });
}

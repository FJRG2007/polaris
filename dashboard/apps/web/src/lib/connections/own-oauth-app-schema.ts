/**
 * The client id and secret of an app somebody registered for their own links,
 * shaped the way `saveOwnOAuthApp` stores it. No screen collects this anymore
 * (setting up a provider app is the administrator's job), so this only
 * validates an app stored before that.
 */

import { z } from "zod";

/** A client id or secret as a provider's dashboard shows it: letters and digits.
 *  Bounded rather than pinned to one provider's exact length. */
const CREDENTIAL_PATTERN = /^[A-Za-z0-9]{16,128}$/;

export const ownOAuthAppSchema = z.object({
    clientId: z
        .string()
        .trim()
        .min(1, "connections.ownApp.errors.clientIdRequired")
        .regex(CREDENTIAL_PATTERN, "connections.ownApp.errors.clientIdShape"),
    clientSecret: z
        .string()
        .trim()
        .min(1, "connections.ownApp.errors.secretRequired")
        .regex(CREDENTIAL_PATTERN, "connections.ownApp.errors.secretShape")
});

export type OwnOAuthAppInput = z.infer<typeof ownOAuthAppSchema>;

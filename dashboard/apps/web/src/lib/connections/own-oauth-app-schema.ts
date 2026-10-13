/**
 * The client id and secret somebody pastes for an app of their own. Shared by
 * the form, which checks it as it is typed, and the action that stores it.
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

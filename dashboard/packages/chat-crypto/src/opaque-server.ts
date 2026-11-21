/**
 * The password lock, server half: the three OPAQUE steps the server runs.
 *
 * The server holds a long-term `serverSetup` (its OPRF seed and AKE key pair)
 * and one registration record per account. Neither lets it compute a user's
 * export key, so neither opens an envelope; what a stolen database plus the
 * setup does allow is an offline guess per password, each costing a full
 * Argon2id at 128 MiB - the residual risk the design names in 3.2.
 *
 * Every function takes the account's id as the OPAQUE user identifier and as
 * the client identity, so a record made for one account cannot be used to sign
 * in as another (the AKE transcript binds it).
 */

import * as opaque from "@serenity-kit/opaque";

function identifiersFor(userId: string): { client: string } {
    if (!userId) throw new RangeError("An OPAQUE exchange belongs to an account");
    return { client: userId };
}

export async function createServerSetup(): Promise<string> {
    await opaque.ready;
    return opaque.server.createSetup();
}

export async function registrationResponse(
    serverSetup: string,
    userId: string,
    registrationRequest: string
): Promise<string> {
    await opaque.ready;
    identifiersFor(userId);
    return opaque.server.createRegistrationResponse({
        serverSetup,
        userIdentifier: userId,
        registrationRequest
    }).registrationResponse;
}

/**
 * Step one of a login. `registrationRecord` may be null: OPAQUE then answers
 * with a response indistinguishable from a real one, so the reply does not
 * reveal whether the account has a password lock at all.
 */
export async function startLogin(
    serverSetup: string,
    userId: string,
    registrationRecord: string | null,
    startLoginRequest: string
): Promise<{ serverLoginState: string; loginResponse: string }> {
    await opaque.ready;
    return opaque.server.startLogin({
        serverSetup,
        userIdentifier: userId,
        registrationRecord,
        startLoginRequest,
        identifiers: identifiersFor(userId)
    });
}

/** Step two. True only when the client proved it knows the password. */
export async function finishLogin(
    userId: string,
    serverLoginState: string,
    finishLoginRequest: string
): Promise<boolean> {
    await opaque.ready;
    try {
        opaque.server.finishLogin({
            serverLoginState,
            finishLoginRequest,
            identifiers: identifiersFor(userId)
        });
        return true;
    } catch {
        return false;
    }
}

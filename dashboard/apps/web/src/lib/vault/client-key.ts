/**
 * The account credential a client is given when it is let in.
 *
 * Approving a client in Polaris is one press and it has to stay one press. By
 * the time somebody says yes they have proved who they are twice - a session,
 * and a vault unlocked in this browser - so sending them off to sign the client
 * in again afterwards asks for the same proof a third time, in a popup, with a
 * password they were not meant to need.
 *
 * So the approval hands back two things: the vault key, sealed to the client's
 * own public half and unreadable here, and this - a credential the client can
 * use to say whose account it is.
 *
 * **It is never shown as an API key.** Polaris has no bearer plugin for
 * sessions, so the only credential that works from a browser extension without a
 * cookie is an API key; that is a fact about the auth stack rather than a
 * decision. What was decided is that it does not belong in Account > API keys,
 * which is a list of things somebody made on purpose and expects to recognise.
 * A row there that appeared by itself, that nobody can explain a year later, is
 * worse than no row: it is the kind of credential people leave alone because
 * they are not sure what it does. The client is listed as a connected app under
 * Sessions instead, where the question "what is signed in to my account" is
 * actually asked, and disconnecting it there is what takes this with it.
 *
 * **Narrow by construction.** It asks for `vault.use` and nothing else, and
 * `scopesAvailableTo` clamps even that to what its owner holds - a key can never
 * exceed the person it belongs to. It is not a session: no cookie, no reach
 * beyond the account's own permissions, and an expiry.
 *
 * One per client, not one per approval. Authorizing the same browser again
 * replaces what it had rather than leaving a second credential behind.
 */

import type { Permission } from "@polaris/core";
import { createApiKey, deleteApiKey, listApiKeys, scopesAvailableTo } from "@polaris/auth";

/** What a client may do with it. One permission, deliberately. */
const CLIENT_SCOPES: readonly Permission[] = ["vault.use"];

/** The longest a name may be, as the schema that validates one says. */
const NAME_MAX = 60;

/** What marks a credential as belonging to a client rather than to its owner. */
const MARK = "polaris-client:";

/**
 * How a client's credential is recognised later.
 *
 * In the description rather than the name: the name is what a person reads, and
 * bookkeeping in a name is bookkeeping somebody edits by accident.
 */
export function clientKeyMark(deviceIdentifier: string): string {
    return `${MARK}${deviceIdentifier}`;
}

/** Whether this credential was issued to a client at all - the rule the API keys
 *  screen hides rows by. */
export function isClientKey(description: string): boolean {
    return description.trim().startsWith(MARK);
}

/** Whether this credential was issued to that particular client. */
export function isClientKeyFor(description: string, deviceIdentifier: string): boolean {
    return description.trim() === clientKeyMark(deviceIdentifier);
}

/** What it is called, for the one place a person ever sees it. */
export function clientKeyName(deviceName: string): string {
    const said = deviceName.trim();
    const full = said === "" ? "Polaris client" : `Polaris client - ${said}`;
    // Three characters back, not one: the ellipsis is three. Reserving one put
    // the name two over the schema's limit, which would have thrown inside
    // `createApiKey` - so every client whose name ran long would have had its
    // approval fail on the length of a label nobody chose.
    return full.length > NAME_MAX ? `${full.slice(0, NAME_MAX - 3).trimEnd()}...` : full;
}

/**
 * Issue the credential for a client that has just been let in.
 *
 * Null rather than a throw when the account holds nothing this could carry -
 * somebody whose `vault.use` was taken away between asking and approving. That
 * is a refusal, and it is the whole of what null means here.
 *
 * A credential that could not be written, on the other hand, throws. The two
 * used to arrive as the same absent field, and a client that cannot use an
 * approval without this was then told its account had lost vault access when
 * what had really happened was a failed write it could simply have asked again
 * after. Nothing downstream can tell them apart once they have been flattened,
 * so they are not flattened.
 */
export async function issueClientKey(
    userId: string,
    device: { readonly identifier: string; readonly name: string }
): Promise<string | null> {
    const allowed = new Set(await scopesAvailableTo(userId));
    const scopes = CLIENT_SCOPES.filter((scope) => allowed.has(scope));
    if (scopes.length === 0) return null;

    // Whatever this client held before, so re-connecting replaces rather than
    // accumulates - read now, cleared further down.
    const held = await listApiKeys(userId).catch(() => []);
    const replacing = held.filter((key) => isClientKeyFor(key.description, device.identifier));

    const created = await createApiKey(userId, {
        name: clientKeyName(device.name),
        description: clientKeyMark(device.identifier),
        environment: "production",
        scopes: [...scopes],
        groupIds: [],
        allowedCidrs: [],
        allowedCountries: [],
        allowedContinents: [],
        allowedUserAgents: [],
        deniedUserAgents: [],
        // A client left in a browser nobody opens again should stop answering.
        expiresInDays: 90
    });

    // Only now, because the other order is one failed write away from a browser
    // that was signed in before it asked and holds nothing after: the approval
    // it spent getting here is gone, so there is nothing left for it to retry
    // with. Clearing afterwards costs a moment where the account carries two
    // credentials for one device, which nothing reads in between.
    for (const key of replacing) {
        await deleteApiKey(userId, key.id).catch(() => undefined);
    }
    return created.secret;
}

/** The scope this issues, so a caller can assert it without restating it. */
export const CLIENT_KEY_SCOPES = CLIENT_SCOPES;

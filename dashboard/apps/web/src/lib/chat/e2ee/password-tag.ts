/**
 * The tag that ties an account's OPAQUE record to its current better-auth
 * password hash (`opaque-service.ts`): a keyed fingerprint of the hash under
 * POLARIS_MASTER_KEY, so a password changed any other way retires the record.
 *
 * Kept apart from `opaque-service.ts` so moving a whole Polaris
 * (`instance-transfer/transfer.ts`) can work it out again under the new
 * instance's key without loading the OPAQUE server: the tag is keyed, so it
 * does not survive a move as it is, and a record whose tag no longer matches
 * signs nobody in.
 */

import { loadEnv } from "@polaris/config";
import { secretFingerprint } from "@polaris/storage";

export const PASSWORD_TAG_SCOPE = "chat-e2ee/opaque-password";

/** The tag of `hash` under `masterKey`, this instance's by default. */
export function passwordTag(hash: string, masterKey: string = loadEnv().POLARIS_MASTER_KEY): string {
    return secretFingerprint(hash, PASSWORD_TAG_SCOPE, masterKey);
}

/**
 * The item to send back when only its password is changing.
 *
 * The vault accepts an item whole - `api/ciphers/:id/partial` takes the folder and
 * the star and nothing else - so changing one field means re-uploading all of them.
 * That makes this the most dangerous write in the extension, and the danger is not
 * the write failing: it is the write succeeding and quietly emptying everything
 * this client does not model. A login can carry notes, custom fields, a password
 * history, an attachment key, even card or identity blocks left over from a change
 * of type. Rebuilding one from the reduced shape the worker decrypts would send
 * nulls for all of it, the server would store exactly that, and nothing on any
 * screen would ever say a word.
 *
 * So this starts from the item as it arrived, still encrypted, and replaces three
 * things. It is pure and separate from the worker for one reason: that failure is
 * invisible, and the only way to know it has not happened is to assert it.
 */

/** A cipher exactly as `api/sync` sent it, still encrypted. */
export type SyncedItem = Record<string, unknown>;

/**
 * Replace an item's password, keeping every other field as it was.
 *
 * `now` is passed in rather than read from the clock so the result is a function of
 * its arguments and can be asserted. The old password moves into the history as the
 * ciphertext it already was - it is never decrypted to be kept, and an item that had
 * no password to begin with gains no history entry rather than an empty one.
 *
 * `lastKnownRevisionDate` is what the server compares to decide whether somebody
 * else has saved since. Omitted when the item carries no revision, because a
 * fabricated one would either refuse a write that was fine or wave one through
 * that was not.
 */
export function withNewPassword(
    item: SyncedItem,
    encryptedPassword: string,
    now: string
): SyncedItem {
    const login = (item["login"] ?? {}) as Record<string, unknown>;
    const replaced = typeof login["password"] === "string" ? login["password"] : null;
    const history: unknown[] = Array.isArray(item["passwordHistory"])
        ? (item["passwordHistory"] as unknown[])
        : [];

    return {
        // Everything the server sent, so no field can be lost by omission. What it
        // will not accept back, its own schema drops - which is why the id, the
        // attachments and the revision are not picked out and removed here.
        ...item,
        login: { ...login, password: encryptedPassword, passwordRevisionDate: now },
        passwordHistory:
            replaced === null ? history : [{ password: replaced, lastUsedDate: now }, ...history],
        lastKnownRevisionDate:
            typeof item["revisionDate"] === "string" ? item["revisionDate"] : undefined
    };
}

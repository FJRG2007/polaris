/**
 * Who is asking, on the two routes a document is actually read and written
 * through.
 *
 * There are two ways to be in a document and only these two: an account with
 * standing on it, or a browser carrying a pass a link gave it. Resolved here,
 * once, so the content route and the stream route cannot drift into disagreeing
 * about what a link is worth - which is the exact shape of bug that ends with a
 * viewer's link writing.
 *
 * The account is asked first and the pass second, so somebody who is signed in
 * AND holding a link gets whatever their account gives them. A pass is a floor
 * for a stranger, never a ceiling on a colleague.
 */

import * as core from "@polaris/core";
import { cookies } from "next/headers";
import { documentAccess } from "./documents";
import { linkPassCookie, readLinkPass } from "./links";

/** What this request may do here, and on whose behalf. */
export interface OfficeReader {
    /** The account, or null for somebody who arrived on a link and has none. A
     *  visitor's edit records no editor: a document edited by somebody who was
     *  never here should not name somebody who was. */
    readonly userId: string | null;
    readonly role: core.OfficeRole;
}

/**
 * Resolve the caller against one document, or null when neither way holds.
 *
 * `userId` is whoever the session says, or null when there is no session. The
 * pass is only consulted when the account does not already reach the document,
 * so a signed-in editor who happens to be holding a viewer's link is still an
 * editor.
 */
export async function officeReader(
    documentId: string,
    userId: string | null
): Promise<OfficeReader | null> {
    if (userId) {
        const access = await documentAccess({ id: userId }, documentId);
        if (access) return { userId, role: access.role };
    }

    const pass = (await cookies()).get(linkPassCookie(documentId))?.value;
    const role = readLinkPass(documentId, pass);
    // The role is inside the signature rather than beside it, so this cannot be
    // promoted by editing the half in front of the dot - see `signLinkPass`.
    return role ? { userId, role } : null;
}

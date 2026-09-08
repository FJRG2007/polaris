"use server";

/**
 * The links a document is handed out on.
 *
 * Its own file rather than a section of the office actions, because everything
 * here answers with, or acts on, something that opens a document for somebody
 * with no account - which is a different thing to get wrong than a rename.
 *
 * Every one of these refuses unless the caller may share the document, which is
 * owning it or running the organization's work. Being able to edit is
 * deliberately not enough: somebody given a document to work on has not been
 * given the right to decide who else sees it, and a link is the widest way of
 * deciding that.
 */

import * as core from "@polaris/core";
import { requireUser } from "@/lib/session";
import * as links from "@/lib/office/links";
import { OfficeAccessError, requireShareable } from "@/lib/office/documents";

function failure(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof OfficeAccessError) return { error: caught.message };
    console.error(caught);
    return { error: fallback };
}

export async function listLinksAction(documentId: string) {
    const user = await requireUser();
    try {
        await requireShareable(user, documentId);
        return { links: await links.listLinks(documentId) };
    } catch (caught) {
        return failure(caught, "Those could not be read.");
    }
}

/** Make one, and hand back its address exactly once. */
export async function createLinkAction(documentId: string, input: unknown) {
    const user = await requireUser();
    const parsed = core.officeLinkSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Check the details." };
    }
    try {
        await requireShareable(user, documentId);
        const made = await links.createLink(documentId, user.id, parsed.data);
        return { url: made.url, view: made.view, links: await links.listLinks(documentId) };
    } catch (caught) {
        return failure(caught, "That link could not be made.");
    }
}

/** The address of one that already exists, for somebody who closed the dialog
 *  before copying it. */
export async function revealLinkAction(documentId: string, linkId: string) {
    const user = await requireUser();
    try {
        await requireShareable(user, documentId);
        const url = await links.revealLink(documentId, linkId);
        return url
            ? { url }
            : {
                  // The master key has moved under it. The link still works for
                  // whoever holds it; it simply cannot be shown again, and
                  // saying so is better than an empty box.
                  error: "That link cannot be shown again. Revoke it and make another."
              };
    } catch (caught) {
        return failure(caught, "That link could not be read.");
    }
}

export async function revokeLinkAction(documentId: string, linkId: string) {
    const user = await requireUser();
    try {
        await requireShareable(user, documentId);
        await links.revokeLink(documentId, linkId);
        return { links: await links.listLinks(documentId) };
    } catch (caught) {
        return failure(caught, "That link could not be stopped.");
    }
}

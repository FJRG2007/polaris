/**
 * A document by its link (/od/<token>).
 *
 * Outside the app shell and outside authentication: whoever holds the link gets
 * the document and nothing else - no rail, no other documents, no way to reach
 * anything this Polaris has. A token that names nothing renders the same card as
 * one that expired, so the URL cannot be used to find out which tokens are real.
 *
 * Unlike a published note, this one can be **editable**, because "send them
 * something they can edit" is what people actually ask for. What makes that
 * tolerable is the shape of what a link can carry: it may write the document and
 * it may do nothing else - it can never share it on, never rename what it is
 * called for everybody else, and never delete it. Sharing takes ownership, and a
 * link is not an owner.
 *
 * Every gate runs server-side on every request, in `lib/office/link-access` -
 * the same order a note share, a Drive share and a snippet use, because they are
 * the same gates.
 */

import * as core from "@polaris/core";
import { getSession } from "@/lib/session";
import { LinkedDocument } from "./linked-document";
import { readByLink } from "@/lib/office/documents";
import { LinkPasswordForm } from "@/components/link-password-form";
import { LinkUnavailable, PublicShell } from "@/components/public-shell";
import { gateOfficeLink, officeLinkDenial } from "@/lib/office/link-access";
import { openOfficeLinkAction, unlockOfficeLinkAction } from "@/app/od/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LinkedOfficePage({
    params
}: {
    params: Promise<{ token: string }>;
}) {
    const { token } = await params;
    const session = await getSession();
    const signedIn = Boolean(session?.user);

    const gate = await gateOfficeLink(token);
    if (!gate.ok) {
        if (gate.reason === "password_required") {
            return (
                <LinkPasswordForm
                    token={token}
                    unlock={unlockOfficeLinkAction}
                    description="This document is behind a password. Type it to open it."
                />
            );
        }
        return <LinkUnavailable signedIn={signedIn} message={officeLinkDenial(gate.reason)} />;
    }

    // The opening is spent here, on the way in, and it is what writes the pass
    // this browser then carries to the content and stream routes. Conditionally,
    // so two people arriving together on the last permitted opening cannot both
    // be let in.
    const opened = await openOfficeLinkAction(token);
    if ("error" in opened) {
        return <LinkUnavailable signedIn={signedIn} message={opened.error} />;
    }

    const found = await readByLink(gate.visit.documentId);
    if (!found) {
        return <LinkUnavailable signedIn={signedIn} message={officeLinkDenial("not_found")} />;
    }

    return (
        <PublicShell signedIn={signedIn} className="max-w-none">
            <LinkedDocument
                documentId={found.id}
                kind={found.kind}
                title={found.title}
                content={found.content ? Array.from(found.content) : null}
                editable={core.officeRoleAtLeast(opened.role, "editor")}
            />
        </PublicShell>
    );
}

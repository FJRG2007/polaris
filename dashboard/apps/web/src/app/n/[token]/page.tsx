/**
 * A note by its public link (/n/<token>).
 *
 * Outside the app shell and outside authentication: whoever holds the link can
 * read the page, and nothing else. A token that names no live link renders the
 * same "not available" card as one that expired, so the URL cannot be used to
 * test which tokens exist.
 *
 * Read-only, deliberately. Somebody outside Polaris wants to read what was
 * written; letting them change it would need an identity Polaris does not have
 * for them, and a document open to the internet to edit is a document open to
 * the internet to edit.
 *
 * Every gate runs server-side on every request, in `lib/notes/share-access` -
 * the same order a share, a drop point and a snippet use, because they are the
 * same gates.
 */

import { getSession } from "@/lib/session";
import { noteActivity } from "@/lib/session-guard";
import { RichText } from "@/components/rich-text/rich-text";
import { readPublishedNote } from "@/lib/notes/share-service";
import { RICH_TEXT_PROSE } from "@/components/rich-text/prose";
import { getDisplayFormat } from "@/lib/display-prefs-service";
import { unlockNoteShareAction } from "@/app/(app)/notes/actions";
import { registerNoteShareView } from "@/lib/notes/share-service";
import { LinkPasswordForm } from "@/components/link-password-form";
import { Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { LinkUnavailable, PublicShell } from "@/components/public-shell";
import { gateNoteShareRequest, noteDenialMessage } from "@/lib/notes/share-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PublicNotePage({ params }: { params: Promise<{ token: string; }>; }) {
    const { token } = await params;
    const session = await getSession();
    const signedIn = Boolean(session?.user);
    // Reading a published note is being here, and the guard that records that
    // runs only on the dashboard - so without this the directory calls somebody
    // absent while they are demonstrably using Polaris.
    await noteActivity(session?.session?.id);

    const gate = await gateNoteShareRequest(token);
    if (!gate.ok) {
        if (gate.reason === "password_required") {
            return <LinkPasswordForm token={token} unlock={unlockNoteShareAction} />;
        }
        return <LinkUnavailable signedIn={signedIn} message={noteDenialMessage(gate.reason)} />;
    }

    // Counted before it is served, and conditionally: two people opening the last
    // permitted view at the same moment must not both get it.
    if (!(await registerNoteShareView(gate.share.id))) {
        return <LinkUnavailable signedIn={signedIn} message={noteDenialMessage("exhausted")} />;
    }

    const note = await readPublishedNote(gate.share);
    if (!note) {
        return <LinkUnavailable signedIn={signedIn} message={noteDenialMessage("not_found")} />;
    }

    const format = await getDisplayFormat();

    return (
        <PublicShell signedIn={signedIn} className="max-w-3xl">
            <Card>
                <CardHeader className="flex flex-col gap-1">
                    <CardTitle className="text-xl">{note.title}</CardTitle>
                    <span className="text-xs text-muted-foreground">
                        Last changed {format.dateTime(note.updatedAt)}
                    </span>
                </CardHeader>
                <CardBody className="flex flex-col gap-6">
                    <RichText value={note.body} className={RICH_TEXT_PROSE} />
                    {note.children.map((child, index) => (
                        <section key={`${child.title}-${index}`} className="flex flex-col gap-2">
                            <h2 className="border-t border-border pt-4 text-base font-semibold tracking-tight">
                                {child.title}
                            </h2>
                            <RichText value={child.body} className={RICH_TEXT_PROSE} />
                        </section>
                    ))}
                </CardBody>
            </Card>
        </PublicShell>
    );
}

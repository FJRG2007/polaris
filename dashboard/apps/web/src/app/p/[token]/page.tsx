/**
 * Public snippet page. Anyone with the link reaches this; no session is needed,
 * because the token - plus a password, or an invitation - is the credential.
 * Every gate runs server-side on each request in lib/snippet-access.
 *
 * Three shapes come out of it. An ordinary snippet is read and painted here. A
 * one-time snippet is NOT: it shows a gate, because loading a page is something
 * a mail scanner does, and spending somebody's secret on a link preview is the
 * failure this whole feature exists to avoid. A sealed snippet is handed to the
 * browser as ciphertext and opened there with the key from the fragment.
 */

import { getSession } from "@/lib/session";
import { SnippetReader } from "./snippet-reader";
import { noteActivity } from "@/lib/session-guard";
import { LinkUnavailable } from "@/components/public-shell";
import { LinkPasswordForm } from "@/components/link-password-form";
import { gateSnippetRequest, snippetDenialMessage } from "@/lib/snippet-access";
import { unlockSnippetAction } from "@/app/(app)/drive/snippets/snippet-actions";
import { logSnippetAccess, readSnippetFiles, registerSnippetView } from "@/lib/snippet-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PublicSnippetPage({
    params
}: {
    params: Promise<{ token: string }>;
}) {
    const { token } = await params;
    const session = await getSession();
    const signedIn = Boolean(session?.user);
    // Reading a snippet is being here, and the guard that records that runs only
    // on the dashboard - so without this the directory calls a user absent while
    // they are demonstrably using Polaris.
    await noteActivity(session?.session?.id);

    const gate = await gateSnippetRequest(token, "view");
    if (!gate.ok) {
        if (gate.reason === "password_required") {
            return <LinkPasswordForm token={token} unlock={unlockSnippetAction} />;
        }
        return <LinkUnavailable signedIn={signedIn} message={snippetDenialMessage(gate.reason)} />;
    }

    const { snippet } = gate;
    const shared = {
        token,
        title: snippet.title,
        description: snippet.description,
        sealed: snippet.clientSealed,
        signedIn
    };

    // A one-time snippet is not spent by rendering its page.
    if (snippet.burnAfterRead) return <SnippetReader {...shared} oneTime files={null} />;

    if (!(await registerSnippetView(snippet.id))) {
        return <LinkUnavailable signedIn={signedIn} message={snippetDenialMessage("exhausted")} />;
    }
    const files = await readSnippetFiles(snippet.id);
    await logSnippetAccess({
        snippetId: snippet.id,
        action: "view",
        ip: gate.ip,
        ipHash: gate.ipHash,
        userAgentHash: gate.userAgentHash
    });

    return (
        <SnippetReader
            {...shared}
            files={files.map((file) => ({
                name: file.name,
                language: file.language,
                body: file.body,
                size: file.size
            }))}
        />
    );
}

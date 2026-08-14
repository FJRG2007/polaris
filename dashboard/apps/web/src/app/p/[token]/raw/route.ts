/**
 * The raw text of a shared snippet, at /p/<token>/raw.
 *
 * The reason a paste is useful from a terminal: `curl` it into a file, pipe it
 * into a shell, diff it against what you have. It runs exactly the same gates as
 * the page - a link that needs a password needs it here too, and an address the
 * page refuses is refused here - and it counts as a view, so a cap means what it
 * says however the text was fetched.
 *
 * Two links have no raw form and say so rather than returning something useless:
 * a sealed snippet is ciphertext nobody here can open, and a one-time snippet
 * must not be spent by a request that could have been a preview fetch.
 */

import { gateSnippetRequest, snippetDenialMessage } from "@/lib/snippet-access";
import { logSnippetAccess, readSnippetFiles, registerSnippetView } from "@/lib/snippet-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Plain text, and never rendered as anything else by a browser that follows it. */
const TEXT_HEADERS = {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "cache-control": "no-store"
};

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const gate = await gateSnippetRequest(token, "raw");
    if (!gate.ok) {
        return new Response(snippetDenialMessage(gate.reason), {
            status: gate.status,
            headers: TEXT_HEADERS
        });
    }
    if (gate.snippet.clientSealed) {
        return new Response("This snippet is sealed. Open it in a browser with its link.", {
            status: 409,
            headers: TEXT_HEADERS
        });
    }
    if (gate.snippet.burnAfterRead) {
        return new Response("This snippet can only be opened once, from its page.", {
            status: 409,
            headers: TEXT_HEADERS
        });
    }

    if (!(await registerSnippetView(gate.snippet.id))) {
        return new Response(snippetDenialMessage("exhausted"), {
            status: 410,
            headers: TEXT_HEADERS
        });
    }

    const files = await readSnippetFiles(gate.snippet.id);
    // ?f= picks one file out of a snippet that holds several. Without it the
    // whole thing comes back, with a header line per file when there is more
    // than one - piping a two-file snippet into a shell should not silently run
    // the second one glued onto the first.
    const wanted = new URL(request.url).searchParams.get("f");
    const chosen = wanted ? files.filter((file) => file.name === wanted) : files;
    if (chosen.length === 0) {
        return new Response("No file by that name.", { status: 404, headers: TEXT_HEADERS });
    }

    await logSnippetAccess({
        snippetId: gate.snippet.id,
        action: "raw",
        reason: wanted ?? undefined,
        ip: gate.ip,
        ipHash: gate.ipHash,
        userAgentHash: gate.userAgentHash
    });

    const body =
        chosen.length === 1
            ? chosen[0]!.body
            : chosen.map((file) => `==> ${file.name} <==\n${file.body}`).join("\n\n");
    return new Response(body, { status: 200, headers: TEXT_HEADERS });
}

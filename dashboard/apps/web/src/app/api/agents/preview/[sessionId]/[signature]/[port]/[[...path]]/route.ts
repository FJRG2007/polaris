// A web server running in a Code session, served under Polaris's own address.
// The signature in the path is the whole of the access: see lib/agents/session-preview.
import { getTranslations } from "@/lib/i18n/request";
import { PREVIEW_SANDBOX, PreviewError, proxyPreview } from "@/lib/agents/session-preview";
import { previewBase, previewPort, readPreviewSignature } from "@/lib/agents/session-preview-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = {
    params: Promise<{ sessionId: string; signature: string; port: string; path?: string[] }>;
};

const WORDS = {
    notFound: "code.preview.errors.notFound",
    gone: "code.preview.errors.gone",
    refused: "code.preview.errors.refused",
    older: "code.preview.errors.older",
    unreachable: "code.preview.errors.unreachable",
    slow: "code.preview.errors.slow"
} as const;

async function said(status: number, word: keyof typeof WORDS, port?: number): Promise<Response> {
    const t = await getTranslations("polar");
    return new Response(t(WORDS[word], { port: String(port ?? "") }), {
        status,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-security-policy": PREVIEW_SANDBOX,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer"
        }
    });
}

async function handle(request: Request, context: Context): Promise<Response> {
    const { sessionId, signature, port: rawPort } = await context.params;
    if (!UUID.test(sessionId) || !readPreviewSignature(sessionId, signature)) return said(404, "notFound");
    const port = previewPort(rawPort);
    if (!port) return said(404, "notFound");

    const url = new URL(request.url);
    const prefix = `${previewBase(sessionId)}/${port}`;
    // The page's own relative addresses resolve under the port only with the
    // slash after it.
    if (url.pathname === prefix) {
        return new Response(null, { status: 308, headers: { location: `${prefix}/${url.search}` } });
    }
    if (!url.pathname.startsWith(`${prefix}/`)) return said(404, "notFound");

    try {
        return await proxyPreview({
            sessionId,
            port,
            pathname: url.pathname,
            search: url.search,
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: request.signal,
            proto: (request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "")).split(",")[0]!.trim()
        });
    } catch (error) {
        const failure = error instanceof PreviewError ? error.failure : "unreachable";
        if (failure === "unreachable") console.error(`[agent-preview] ${sessionId}:${port}:`, error);
        return said(failure === "slow" ? 504 : failure === "gone" ? 404 : 502, failure, port);
    }
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };

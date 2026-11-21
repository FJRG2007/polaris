/**
 * The link-preview pictures: `/api/og/default` for the plain branded banner,
 * `/api/og/<kind>/<token>` for one public link.
 *
 * Fetched by chat apps' crawlers with no session. It reads metadata only, never
 * spends a view or a download, and names the item only when `mayDisclose` says
 * anybody with the link could open it right now; an unknown token draws exactly
 * what a refused one does. A short cache lifetime keeps a revoked link's name
 * from outliving it by more than a few minutes.
 */

import { getTranslations } from "@/lib/i18n/request";
import { rateLimit } from "@/lib/rate-limit-service";
import { isPreviewKind } from "@/lib/link-preview/policy";
import { previewWords } from "@/lib/link-preview/metadata";
import { clientIp, hashForLog } from "@/lib/request-context";
import { renderPreviewImage } from "@/lib/link-preview/image";
import { resolveLinkPreview } from "@/lib/link-preview/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LINK_MAX_AGE = 300;
const BANNER_MAX_AGE = 86_400;

export async function GET(_request: Request, { params }: { params: Promise<{ parts: string[] }> }) {
    const { parts } = await params;
    const [kind, token] = parts;

    const address = hashForLog(await clientIp()) ?? "unknown";
    if (!(await rateLimit(`link-preview:${address}`, 120, 60_000)).ok) {
        return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
    }

    if (parts.length !== 2 || !kind || !token || !isPreviewKind(kind)) {
        const t = await getTranslations("common");
        return renderPreviewImage({ tagline: t("meta.description") }, BANNER_MAX_AGE);
    }

    const preview = await resolveLinkPreview(kind, token);
    const words = await previewWords(preview);
    // A disclosed link shows its kind above its name; the generic preview
    // shows the kind as the name and says what the link is for.
    const text = words.title
        ? {
              label: words.label,
              title: words.title,
              detail: words.detail,
              avatar: kind === "profile" || kind === "org"
          }
        : { title: words.label, detail: words.description };
    return renderPreviewImage(text, LINK_MAX_AGE);
}

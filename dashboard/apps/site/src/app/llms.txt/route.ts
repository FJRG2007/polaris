import { llmsText } from "@/data/llms";
import { asset, siteData, SITE_ORIGIN, words } from "@/lib/site";

export const dynamic = "force-static";

/** `/llms.txt`, written once at export time (see `data/llms.ts`). */
export function GET(): Response {
    const site = SITE_ORIGIN + asset("").replace(/\/+$/, "");
    const body = llmsText(siteData(), site, words("en").meta.description);
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

/**
 * The software inventory an image scan produced, as a CycloneDX JSON download.
 */

import { scanInput } from "../../../../../model/schemas";
import { requireSecurityUser } from "../../../../../lib/access";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
    await requireSecurityUser();
    const parsed = scanInput.safeParse({ scanId: (await context.params).id });
    if (!parsed.success) return new Response("Not found", { status: 404 });
    const sbom = await (await import("../../../../../lib/service")).sbomOf(parsed.data.scanId);
    if (!sbom) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(sbom.body), {
        headers: {
            "content-type": "application/vnd.cyclonedx+json",
            "content-disposition": `attachment; filename="${sbom.name}"`,
            "cache-control": "private, no-store"
        }
    });
}

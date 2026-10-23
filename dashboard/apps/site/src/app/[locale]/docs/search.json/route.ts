/** The docs search index in one language, fetched once when the search box is first used. */

import { SITE_LOCALES } from "@/data/builders";
import { isLocale, searchRecords } from "@/lib/site";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
    return SITE_LOCALES.map((locale) => ({ locale }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
    const { locale } = await params;
    return Response.json(isLocale(locale) ? searchRecords(locale) : []);
}

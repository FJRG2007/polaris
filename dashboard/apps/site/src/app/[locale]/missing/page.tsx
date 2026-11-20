/**
 * The not-found page in one language. GitHub Pages answers every missing
 * address with the one `404.html` (`global-not-found.tsx`), which sends a
 * Spanish reader here so the page is not in two languages at once.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NotFoundView } from "@/components/not-found-view";
import { isLocale, pageMetadata, words } from "@/lib/site";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    if (!isLocale(locale)) return {};
    return { ...pageMetadata(locale, { title: words(locale).notFound.title }), robots: { index: false } };
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    return <NotFoundView locale={locale} />;
}

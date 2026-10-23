import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocView, findDoc } from "@/views/docs";
import { isLocale, pageMetadata, siteData } from "@/lib/site";

type Props = { params: Promise<{ locale: string; slug: string }> };

export function generateStaticParams({ params }: { params: { locale: string } }) {
    return isLocale(params.locale)
        ? siteData().docs[params.locale].map((page) => ({ slug: page.slug }))
        : [];
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale, slug } = await params;
    const page = isLocale(locale) ? findDoc(locale, slug) : undefined;
    if (!isLocale(locale) || !page) return {};
    return pageMetadata(locale, {
        title: page.title,
        description: page.summary,
        page: `docs/${page.slug}/`
    });
}

export default async function Page({ params }: Props) {
    const { locale, slug } = await params;
    const page = isLocale(locale) ? findDoc(locale, slug) : undefined;
    if (!isLocale(locale) || !page) notFound();
    return <DocView locale={locale} page={page} />;
}

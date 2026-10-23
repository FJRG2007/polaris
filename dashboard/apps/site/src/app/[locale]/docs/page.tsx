import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsIndexView } from "@/views/docs";
import { isLocale, words, pageMetadata } from "@/lib/site";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    if (!isLocale(locale)) return {};
    return pageMetadata(locale, {
        title: words(locale).docs.title,
        description: words(locale).meta.docs,
        page: "docs/"
    });
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    return <DocsIndexView locale={locale} />;
}

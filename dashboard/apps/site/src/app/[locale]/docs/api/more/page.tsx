import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { apiPath } from "@/data/api-pages";
import { isLocale, pageMetadata, words } from "@/lib/site";
import { ApiMoreView } from "@/views/api-docs";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    if (!isLocale(locale)) return {};
    const t = words(locale).api;
    return pageMetadata(locale, {
        title: `${t.undocumented} - ${t.title}`,
        description: t.undocumentedHint,
        page: apiPath.more()
    });
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    return <ApiMoreView locale={locale} />;
}

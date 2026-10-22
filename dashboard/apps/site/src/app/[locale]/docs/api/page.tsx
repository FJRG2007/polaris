import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, words } from "@/lib/site";
import { ApiDocsView } from "@/views/api-docs";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    return isLocale(locale) ? { title: `${words(locale).api.title} - Polaris` } : {};
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    return <ApiDocsView locale={locale} />;
}

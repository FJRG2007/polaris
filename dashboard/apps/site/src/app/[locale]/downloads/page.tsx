import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, words } from "@/lib/site";
import { DownloadsView } from "@/views/downloads";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    return isLocale(locale) ? { title: `${words(locale).downloads.title} - Polaris` } : {};
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    return <DownloadsView locale={locale} />;
}

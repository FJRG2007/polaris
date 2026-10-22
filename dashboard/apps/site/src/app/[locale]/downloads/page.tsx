import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, words, pageMetadata, siteData } from "@/lib/site";
import { SiteDownloads } from "@/components/site-downloads";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    return isLocale(locale) ? pageMetadata(locale, {
              title: words(locale).downloads.title,
              description: words(locale).meta.downloads,
              page: "downloads/"
          }) : {};
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    const data = siteData();
    return <SiteDownloads locale={locale} repo={data.repo} data={data.downloadsPage} />;
}

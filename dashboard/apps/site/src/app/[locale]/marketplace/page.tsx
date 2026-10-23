import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { href, isLocale, words, pageMetadata } from "@/lib/site";
import { siteData } from "@/lib/site";
import { MarketplaceGrid } from "@/views/marketplace-grid";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    return isLocale(locale)
        ? pageMetadata(locale, {
              title: words(locale).market.title,
              description: words(locale).meta.marketplace,
              page: "marketplace/"
          })
        : {};
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    return (
        <>
            <div className="flex flex-col gap-1">
                <h1 className="text-3xl font-semibold tracking-tight">
                    {words(locale).market.title}
                </h1>
                <p className="text-muted-foreground">{words(locale).market.intro}</p>
            </div>
            <MarketplaceGrid
                apps={siteData().locales[locale].apps}
                builtIn={siteData().locales[locale].builtIn}
                builtInWords={siteData().locales[locale].builtInWords}
                pages={href(locale, "marketplace/")}
                t={words(locale).market}
            />
        </>
    );
}

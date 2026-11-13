import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@polaris/ui";
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
        // The dashboard's marketplace column: the header inside it, as it is there.
        <div className="flex min-w-0 flex-col gap-6">
            <PageHeader
                title={words(locale).market.title}
                description={words(locale).market.intro}
            />
            <MarketplaceGrid
                apps={siteData().locales[locale].apps}
                builtIn={siteData().locales[locale].builtIn}
                builtInWords={siteData().locales[locale].builtInWords}
                pages={href(locale, "marketplace/")}
                install={`${href(locale)}#start`}
                locale={locale}
                words={siteData().locales[locale].store}
            />
        </div>
    );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, pageMetadata } from "@/lib/site";
import { AddonPageView, addonIds, findAddon } from "@/views/addon-page";

type Props = { params: Promise<{ locale: string; addonId: string }> };

export function generateStaticParams({ params }: { params: { locale: string } }) {
    return isLocale(params.locale) ? addonIds(params.locale).map((addonId) => ({ addonId })) : [];
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale, addonId } = await params;
    const addon = isLocale(locale) ? findAddon(locale, addonId) : undefined;
    if (!isLocale(locale) || !addon) return {};
    return pageMetadata(locale, {
        title: addon.name,
        description: addon.summary,
        page: `marketplace/addons/${addon.id}/`
    });
}

export default async function Page({ params }: Props) {
    const { locale, addonId } = await params;
    const addon = isLocale(locale) ? findAddon(locale, addonId) : undefined;
    if (!isLocale(locale) || !addon) notFound();
    return <AddonPageView locale={locale} addon={addon} />;
}

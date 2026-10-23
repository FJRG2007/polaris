import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, pageMetadata } from "@/lib/site";
import { AppPageView, appIds, findApp } from "@/views/app-page";

type Props = { params: Promise<{ locale: string; appId: string }> };

export function generateStaticParams({ params }: { params: { locale: string } }) {
    return isLocale(params.locale) ? appIds(params.locale).map((appId) => ({ appId })) : [];
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale, appId } = await params;
    const app = isLocale(locale) ? findApp(locale, appId) : undefined;
    if (!isLocale(locale) || !app) return {};
    const entry = "store" in app ? app.store : app.builtIn;
    const lead = entry.shots[0];
    return pageMetadata(locale, {
        title: entry.name,
        description: "store" in app ? app.store.summary : app.builtIn.description,
        page: `marketplace/${entry.id}/`,
        picture: lead && { file: lead.dark, alt: lead.alt }
    });
}

export default async function Page({ params }: Props) {
    const { locale, appId } = await params;
    const app = isLocale(locale) ? findApp(locale, appId) : undefined;
    if (!isLocale(locale) || !app) notFound();
    return <AppPageView locale={locale} app={app} />;
}

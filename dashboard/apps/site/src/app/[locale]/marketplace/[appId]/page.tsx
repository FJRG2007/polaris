import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, pageMetadata, siteData } from "@/lib/site";
import { BuiltInAppView, findBuiltIn } from "@/views/built-in-app";

type Props = { params: Promise<{ locale: string; appId: string }> };

export function generateStaticParams({ params }: { params: { locale: string } }) {
    return isLocale(params.locale)
        ? siteData().locales[params.locale].builtIn.map((app) => ({ appId: app.id }))
        : [];
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale, appId } = await params;
    const app = isLocale(locale) ? findBuiltIn(locale, appId) : undefined;
    if (!isLocale(locale) || !app) return {};
    return pageMetadata(locale, {
        title: app.name,
        description: app.description,
        page: `marketplace/${app.id}/`
    });
}

export default async function Page({ params }: Props) {
    const { locale, appId } = await params;
    const app = isLocale(locale) ? findBuiltIn(locale, appId) : undefined;
    if (!isLocale(locale) || !app) notFound();
    return <BuiltInAppView locale={locale} app={app} />;
}

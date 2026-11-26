import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, pageMetadata } from "@/lib/site";
import { PluginPageView, pluginIds, findPlugin } from "@/views/plugin-page";

type Props = { params: Promise<{ locale: string; pluginId: string }> };

export function generateStaticParams({ params }: { params: { locale: string } }) {
    return isLocale(params.locale) ? pluginIds(params.locale).map((pluginId) => ({ pluginId })) : [];
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale, pluginId } = await params;
    const plugin = isLocale(locale) ? findPlugin(locale, pluginId) : undefined;
    if (!isLocale(locale) || !plugin) return {};
    return pageMetadata(locale, {
        title: plugin.name,
        description: plugin.summary,
        page: `marketplace/plugins/${plugin.id}/`
    });
}

export default async function Page({ params }: Props) {
    const { locale, pluginId } = await params;
    const plugin = isLocale(locale) ? findPlugin(locale, pluginId) : undefined;
    if (!isLocale(locale) || !plugin) notFound();
    return <PluginPageView locale={locale} plugin={plugin} />;
}

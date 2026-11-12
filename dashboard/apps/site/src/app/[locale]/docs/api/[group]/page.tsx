import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, pageMetadata, siteData, words } from "@/lib/site";
import { apiPath, groupSlug } from "@/data/api-pages";
import { ApiGroupView, findGroup } from "@/views/api-docs";

type Props = { params: Promise<{ locale: string; group: string }> };

export function generateStaticParams() {
    return siteData().api.groups.map((group) => ({ group: groupSlug(group.tag) }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale, group: slug } = await params;
    if (!isLocale(locale)) return {};
    const t = words(locale).api;
    const group = findGroup(slug);
    if (!group) return {};
    return pageMetadata(locale, {
        title: `${group.tag} - ${t.title}`,
        description: t.groupIntro.replace("{group}", group.tag),
        page: apiPath.group(group.tag)
    });
}

export default async function Page({ params }: Props) {
    const { locale, group: slug } = await params;
    if (!isLocale(locale)) notFound();
    const group = findGroup(slug);
    if (!group) notFound();
    return <ApiGroupView locale={locale} group={group} />;
}

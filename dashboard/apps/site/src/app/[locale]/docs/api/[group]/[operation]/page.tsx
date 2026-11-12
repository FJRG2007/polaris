import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, pageMetadata, siteData, words } from "@/lib/site";
import { apiPath, groupSlug, operationSlug } from "@/data/api-pages";
import { ApiOperationView, findOperation } from "@/views/api-docs";

type Props = { params: Promise<{ locale: string; group: string; operation: string }> };

/** Both segments: the group page's own list is not handed down to a page under it. */
export function generateStaticParams() {
    return siteData().api.groups.flatMap((group) =>
        group.operations.map((op) => ({ group: groupSlug(group.tag), operation: operationSlug(op) }))
    );
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale, group, operation } = await params;
    const found = findOperation(group, operation);
    if (!isLocale(locale) || !found) return {};
    const op = found.operation;
    return pageMetadata(locale, {
        title: `${op.summary || op.path} - ${words(locale).api.title}`,
        description: op.description || `${op.method} ${op.path}`,
        page: apiPath.operation(op)
    });
}

export default async function Page({ params }: Props) {
    const { locale, group, operation } = await params;
    const found = findOperation(group, operation);
    if (!isLocale(locale) || !found) notFound();
    return <ApiOperationView locale={locale} group={found.group} operation={found.operation} />;
}

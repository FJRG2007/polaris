/** The frame of every page in one language. */

import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SITE_LOCALES } from "@/data/builders";
import { isLocale, pageMetadata, SITE_VIEWPORT } from "@/lib/site";

export const viewport = SITE_VIEWPORT;
import { SiteShell } from "@/components/site-shell";

export const dynamicParams = false;

export function generateStaticParams() {
    return SITE_LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
    params
}: {
    params: Promise<{ locale: string }>;
}): Promise<Metadata> {
    const { locale } = await params;
    return isLocale(locale) ? pageMetadata(locale, {}) : {};
}

export default async function LocaleLayout({
    children,
    params
}: {
    children: ReactNode;
    params: Promise<{ locale: string }>;
}) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    return <SiteShell locale={locale}>{children}</SiteShell>;
}

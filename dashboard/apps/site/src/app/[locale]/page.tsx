import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/site";
import { HomeView } from "@/views/home";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { locale } = await params;
    return isLocale(locale) ? { title: "Polaris" } : {};
}

export default async function Page({ params }: Props) {
    const { locale } = await params;
    if (!isLocale(locale)) notFound();
    return <HomeView locale={locale} />;
}

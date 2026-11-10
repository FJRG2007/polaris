import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("connectors");

export default async function Page({
    searchParams
}: {
    searchParams: Promise<{ connector?: string | string[] }>;
}) {
    const raw = (await searchParams).connector;
    return <SettingsSectionPage id="connectors" connector={Array.isArray(raw) ? raw[0] : raw} />;
}

import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("usage");

export default function Page() {
    return <SettingsSectionPage id="usage" />;
}

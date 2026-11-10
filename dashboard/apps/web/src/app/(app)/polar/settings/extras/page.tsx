import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("extras");

export default function Page() {
    return <SettingsSectionPage id="extras" />;
}

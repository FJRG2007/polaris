import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("memory");

export default function Page() {
    return <SettingsSectionPage id="memory" />;
}

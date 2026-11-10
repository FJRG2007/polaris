import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("skills");

export default function Page() {
    return <SettingsSectionPage id="skills" />;
}

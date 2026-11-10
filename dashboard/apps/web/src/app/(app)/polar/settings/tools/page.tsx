import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("tools");

export default function Page() {
    return <SettingsSectionPage id="tools" />;
}

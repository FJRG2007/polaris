import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("coding-tools");

export default function Page() {
    return <SettingsSectionPage id="coding-tools" />;
}

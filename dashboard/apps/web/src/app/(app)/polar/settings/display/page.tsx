import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("display");

export default function Page() {
    return <SettingsSectionPage id="display" />;
}

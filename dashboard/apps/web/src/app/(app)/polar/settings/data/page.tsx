import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("data");

export default function Page() {
    return <SettingsSectionPage id="data" />;
}

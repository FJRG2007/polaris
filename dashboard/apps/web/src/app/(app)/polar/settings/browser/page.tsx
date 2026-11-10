import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("browser");

export default function Page() {
    return <SettingsSectionPage id="browser" />;
}

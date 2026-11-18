import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("providers");

export default function Page() {
    return <SettingsSectionPage id="providers" />;
}

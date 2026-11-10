import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("permissions");

export default function Page() {
    return <SettingsSectionPage id="permissions" />;
}

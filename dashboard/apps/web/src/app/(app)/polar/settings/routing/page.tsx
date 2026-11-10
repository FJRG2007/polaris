import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("routing");

export default function Page() {
    return <SettingsSectionPage id="routing" />;
}

import { SettingsSectionPage, sectionMetadata } from "../section-page";

export const generateMetadata = () => sectionMetadata("agents");

export default function Page() {
    return <SettingsSectionPage id="agents" />;
}

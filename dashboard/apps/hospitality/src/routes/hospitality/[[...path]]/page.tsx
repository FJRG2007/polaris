/**
 * Hospitality: `/hospitality` is the menu manager for now. The server hands over
 * the frame and nothing else; the screen reads its data in the browser, so the
 * header is on screen before any request has left.
 */

import { host } from "@polaris/app-host";
import { HospitalityScreen } from "../../../screens/menu-screen";

export const dynamic = "force-dynamic";

export default async function HospitalityPage() {
    const user = await host.session.requirePermission("hospitality.use");
    const manager = await host.session.sessionCan(user, "hospitality.manage");
    return <HospitalityScreen manager={manager} />;
}

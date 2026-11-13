/**
 * A device asking to join (/vpn/register/<auth id>). The Tailscale app
 * opens the control server's `/register/<id>`, which the edge sends here
 * (`lib/vpn/edge.ts`). The signed-in reader sees the request and adds the
 * device to their own; an id that is not one Headscale mints is refused before
 * anything else is read.
 */

import * as vpn from "@/lib/vpn/service";
import { notFound } from "next/navigation";
import { vpnMeshOn } from "@/lib/vpn/mesh";
import { requireUser } from "@/lib/session";
import { VpnNoAccess } from "../../no-access";
import { authIdSchema } from "@/lib/vpn/settings";
import { RegisterDevice } from "./register-device";

export const dynamic = "force-dynamic";

export default async function VpnRegisterPage({ params }: { params: Promise<{ authId: string }> }) {
    const user = await requireUser();
    if (!(await vpnMeshOn())) notFound();
    const parsed = authIdSchema.safeParse((await params).authId);
    if (!(await vpn.mayJoin(user))) return <VpnNoAccess />;
    return (
        <RegisterDevice
            authId={parsed.success ? parsed.data : null}
            account={user.name || user.email}
            isAdmin={user.isAdmin}
        />
    );
}

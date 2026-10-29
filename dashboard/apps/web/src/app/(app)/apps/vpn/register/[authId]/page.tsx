/**
 * A device asking to join (/apps/vpn/register/<auth id>). The Tailscale app
 * opens the control server's `/register/<id>`, which the edge sends here
 * (`lib/vpn/edge.ts`). The signed-in reader sees the request and adds the
 * device to their own; an id that is not one Headscale mints is refused before
 * anything else is read.
 */

import { requireUser } from "@/lib/session";
import { authIdSchema } from "@/lib/vpn/settings";
import { RegisterDevice } from "./register-device";

export const dynamic = "force-dynamic";

export default async function VpnRegisterPage({ params }: { params: Promise<{ authId: string }> }) {
    const user = await requireUser();
    const parsed = authIdSchema.safeParse((await params).authId);
    return (
        <RegisterDevice
            authId={parsed.success ? parsed.data : null}
            account={user.name || user.email}
        />
    );
}

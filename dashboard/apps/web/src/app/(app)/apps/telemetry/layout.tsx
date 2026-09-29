import type { ReactNode } from "react";
import { Messages } from "@/components/i18n/messages";

/** Every screen of Telemetry draws its words from this namespace. */
export default function TelemetryLayout({ children }: { children: ReactNode }) {
    return <Messages namespaces={["telemetry"]}>{children}</Messages>;
}

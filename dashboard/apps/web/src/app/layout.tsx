import "./globals.css";
import "@polaris/ui/styles.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DropGuard } from "@/components/drop-guard";

export const metadata: Metadata = {
    title: "Polaris",
    description: "Home-lab control plane - drive, connections, and more."
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body>
                <DropGuard />
                {children}
            </body>
        </html>
    );
}

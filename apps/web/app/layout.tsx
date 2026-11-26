import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "RSTAR ONE", template: "%s · RSTAR ONE" },
  description: "RSTAR ONE — organisation operating system for RSTAR TV. Technology & Operations by BusinessBOX.",
  icons: { icon: "/rstar-tv-logo.png" },
};

export const viewport: Viewport = { themeColor: "#CC323A", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

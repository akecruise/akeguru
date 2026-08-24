import type { Metadata } from "next";
import { IBM_Plex_Sans_Thai, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Nav } from "@/components/Nav";
import { DataFreshnessBadge } from "@/components/DataFreshnessBadge";

// "Research terminal" identity (per the akeguru-dashboard.html design reference) -- mono for
// tickers/numbers/meta, a Thai-aware sans for prose, since this app's own agent output is
// routinely Thai. next/font/google self-hosts + optimizes loading rather than a raw Google Fonts
// <link> tag, same reasoning Geist already used here.
const plexSans = IBM_Plex_Sans_Thai({
  variable: "--font-sans",
  subsets: ["latin", "thai"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "akeguru",
  description: "Personal stock research — fundamentals, watchlist, screener, and valuation score.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>
          <Nav />
          {children}
          <footer className="mx-auto w-full max-w-6xl px-6 py-6">
            <DataFreshnessBadge />
          </footer>
        </Providers>
      </body>
    </html>
  );
}

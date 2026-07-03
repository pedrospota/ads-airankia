import type { Metadata } from "next";
import { Instrument_Sans, Newsreader, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

/**
 * Typography system — the editorial signature:
 *   --font-ui       Instrument Sans (variable wght) → all body & UI text;
 *                   loaded as a VARIABLE font so intermediate weights
 *                   (e.g. the ui-kit's 550 buttons) render true, not snapped.
 *   --font-display  Newsreader (variable + opsz axis, normal/italic)
 *                   → page titles, login hero, empty-state titles ONLY.
 *                   The opsz axis + `font-optical-sizing:auto` (globals.css)
 *                   gives 30-40px titles the display cut, not the text cut.
 *   --font-geist-mono Geist Mono                    → tabular numbers, mono cells
 */
const instrumentSans = Instrument_Sans({
  variable: "--font-ui",
  subsets: ["latin"],
});

const newsreader = Newsreader({
  variable: "--font-display",
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Rankia Ads — Create your campaign in minutes",
  description:
    "Create Google Ads campaigns with step-by-step guidance. The AI sets it up for you and you decide when to turn it on.",
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${newsreader.variable} ${geistMono.variable} dark h-full`}
      suppressHydrationWarning
    >
      <body className="h-full antialiased" style={{ background: "#09090B", color: "#F5F6F7" }}>
        {/* Anti-FOUC: runs as the first body child so document.body exists (a
            <head> script would see document.body === null and throw). Body
            already defaults to dark inline; this only re-paints for light mode
            and keeps the html theme class in sync for CSS scoping. */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('ads-theme')||'dark';document.body.style.background=t==='dark'?'#09090B':'#FCFCFC';document.body.style.color=t==='dark'?'#F5F6F7':'#101012';document.documentElement.classList.toggle('dark',t==='dark');document.documentElement.classList.toggle('light',t!=='dark');}catch(e){}})()` }}
        />
        {/* Atmosphere: fixed full-viewport film grain (inline SVG feTurbulence),
            opacity 0.025, pointer-events none — defined in globals.css. */}
        <div aria-hidden="true" className="grain" />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

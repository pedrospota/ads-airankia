import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ModeProvider } from "@/components/mode-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
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
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full`} suppressHydrationWarning>
      <body className="h-full antialiased" style={{ background: '#0A0A0E', color: '#FAFAFA' }}>
        {/* Anti-FOUC: runs as the first body child so document.body exists (a
            <head> script would see document.body === null and throw). Body
            already defaults to dark inline; this only re-paints for light mode. */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('ads-theme')||'dark';document.body.style.background=t==='dark'?'#0A0A0E':'#FFFFFF';document.body.style.color=t==='dark'?'#FAFAFA':'#111827';}catch(e){}})()` }}
        />
        <ThemeProvider>
          <ModeProvider>{children}</ModeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
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
  title: "AI Rankia Ads — Citation Retargeting",
  description:
    "Run display ads on the exact URLs that AI models cite. Capture buyers at peak intent.",
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
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('ads-theme')||'dark';document.body.style.background=t==='dark'?'#0A0A0E':'#FFFFFF';document.body.style.color=t==='dark'?'#FAFAFA':'#111827';})()` }} />
      </head>
      <body className="h-full antialiased" style={{ background: '#0A0A0E', color: '#FAFAFA' }}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

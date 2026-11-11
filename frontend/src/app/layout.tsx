import type { Metadata } from "next";
import { Tajawal, Caveat } from "next/font/google";
import "./globals.css";
import { SentryInit } from "@/components/common/SentryInit";

// Brand font from abdallahhelal.com — Latin + Arabic glyphs; 800 for display,
// 700 bold, 500 medium, 400 regular, 300 light.
const tajawal = Tajawal({
  variable: "--font-sans",
  subsets: ["latin", "arabic"],
  weight: ["300", "400", "500", "700", "800", "900"],
});

// Hand / accent font — used sparingly (marker highlights, small flourishes).
const caveat = Caveat({
  variable: "--font-hand",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Podcast Studio",
  description: "Remote podcast recording studio by Abdallah Helal",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${tajawal.variable} ${caveat.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans bg-cream text-ink">
        <SentryInit />
        {children}
      </body>
    </html>
  );
}

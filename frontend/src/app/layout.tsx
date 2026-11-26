import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Tajawal, Caveat } from "next/font/google";
import "./globals.css";
import { SentryInit } from "@/components/common/SentryInit";

// UI font: Plus Jakarta Sans — tight, geometric Latin that reads well at
// small sizes. It has no Arabic glyphs, so Arabic text (names, titles)
// falls through to Tajawal, the brand's Arabic face.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-latin",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});
const tajawal = Tajawal({
  variable: "--font-arabic",
  subsets: ["arabic"],
  weight: ["400", "500", "700", "800"],
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
      className={`${jakarta.variable} ${tajawal.variable} ${caveat.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans bg-cream text-ink">
        <SentryInit />
        {children}
      </body>
    </html>
  );
}

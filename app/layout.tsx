import type { Metadata } from "next";
import { DM_Sans, Newsreader } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
});

export const metadata: Metadata = {
  title: "Retold — Gemini film concept",
  description:
    "A concept demo exploring how a camera roll could become a generative film.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${newsreader.variable}`}>
      <body>{children}</body>
    </html>
  );
}

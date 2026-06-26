import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Onyx Base — Telegram-backed key-value & file storage for developers",
  description:
    "A lightweight Supabase/Firebase-style platform. No database setup — only a Bot Token + Chat ID. Store key-values AND files up to 2 GB each, unlimited & free. CLI, REST API, and a real-time web dashboard.",
  keywords: ["Onyx Base", "key-value", "file storage", "Telegram", "developer platform", "REST API", "CLI"],
  authors: [{ name: "Onyx Base" }],
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png", sizes: "64x64" },
    ],
    apple: [
      { url: "/apple-icon.png", type: "image/png", sizes: "180x180" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen`}
      >
        <Providers>{children}</Providers>
        <SonnerToaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}

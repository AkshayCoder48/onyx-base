import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
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
        className={`${inter.variable} ${jetbrainsMono.variable} ${spaceGrotesk.variable} font-sans antialiased text-foreground min-h-screen`}
      >
        <Providers>{children}</Providers>
        <SonnerToaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}

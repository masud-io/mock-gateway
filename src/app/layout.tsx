import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { CommandPalette } from "@/components/command-palette";
import { Providers } from "@/components/providers";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mock API Gateway",
  description: "Mock third-party REST and SOAP APIs for your clients and projects",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full">
        <Providers>
          <div className="flex h-full">
            {/* Sidebar and pages read the URL and fetch on the client, so each sits behind a Suspense boundary (Cache Components) */}
            <Suspense fallback={<aside className="w-72 shrink-0 border-r border-zinc-200 dark:border-zinc-800" />}>
              <Sidebar />
            </Suspense>
            <main className="min-w-0 flex-1 overflow-y-auto">
              <Suspense fallback={<p className="p-6 text-sm text-zinc-500">Loading…</p>}>{children}</Suspense>
            </main>
          </div>
          <CommandPalette />
        </Providers>
      </body>
    </html>
  );
}

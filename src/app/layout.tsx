import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
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
          {/* The shell reads the URL (hides the sidebar on /login), so it sits behind a Suspense boundary (Cache Components) */}
          <Suspense fallback={null}>
            <AppShell>
              <Suspense fallback={<p className="p-6 text-sm text-zinc-500">Loading…</p>}>{children}</Suspense>
            </AppShell>
          </Suspense>
        </Providers>
      </body>
    </html>
  );
}

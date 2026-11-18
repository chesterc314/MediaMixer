import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "Media Mixer — join media in your browser",
  description:
    "Join any number of videos or audios into one file, entirely in your browser. No uploads, no server processing.",
};

const themeScript = `
  let theme;
  try {
    theme = localStorage.getItem('media-mixer-theme');
  } catch (error) {
    console.warn('Theme preference could not be read:', error);
  }
  document.documentElement.dataset.theme =
    theme === 'light' || theme === 'dark'
      ? theme
      : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

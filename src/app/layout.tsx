import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "M-ZERO",
  description: "Design-to-Code QA automation (Figma ↔ Web CSS)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}


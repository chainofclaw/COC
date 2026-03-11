import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "COC IPFS File Manager",
  description: "Decentralized file management powered by COC blockchain IPFS",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}

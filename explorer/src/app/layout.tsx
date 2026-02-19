import type { Metadata, Viewport } from "next"
import Link from "next/link"
import "./globals.css"
import { ConnectionStatus } from "@/components/ConnectionStatus"
import { SearchBar } from "@/components/SearchBar"
import { MobileNav } from "@/components/MobileNav"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#2563eb",
}

export const metadata: Metadata = {
  title: "COC Explorer - ChainOfClaw Block Explorer",
  description: "Explore blocks, transactions, and addresses on the COC blockchain",
  openGraph: {
    title: "COC Explorer",
    description: "ChainOfClaw Block Explorer - Prowl Testnet",
    siteName: "COC Explorer",
    type: "website",
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="min-h-screen flex flex-col">
          <header className="bg-blue-600 text-white shadow-lg">
            <div className="container mx-auto px-4 py-3 sm:py-4">
              <div className="flex items-center justify-between gap-2 sm:gap-4">
                <div className="flex items-center gap-3 sm:gap-6 min-w-0">
                  <Link href="/" className="text-xl sm:text-2xl font-bold hover:text-blue-200 whitespace-nowrap shrink-0">
                    COC Explorer
                  </Link>
                  <nav className="hidden sm:flex items-center space-x-4 text-sm">
                    <Link href="/" className="hover:text-blue-200">Blocks</Link>
                    <Link href="/mempool" className="hover:text-blue-200">Mempool</Link>
                    <Link href="/contracts" className="hover:text-blue-200">Contracts</Link>
                    <Link href="/validators" className="hover:text-blue-200">Validators</Link>
                    <Link href="/governance" className="hover:text-blue-200">Governance</Link>
                    <Link href="/stats" className="hover:text-blue-200">Stats</Link>
                    <Link href="/network" className="hover:text-blue-200">Network</Link>
                  </nav>
                </div>
                <div className="hidden sm:block flex-1 max-w-md">
                  <SearchBar />
                </div>
                <div className="flex items-center gap-2">
                  <ConnectionStatus />
                  <MobileNav />
                </div>
              </div>
              {/* Mobile search bar - below header row */}
              <div className="sm:hidden mt-3">
                <SearchBar />
              </div>
            </div>
          </header>
          <main className="flex-1 container mx-auto px-3 sm:px-4 py-4 sm:py-8">
            {children}
          </main>
          <footer className="bg-gray-800 text-white py-4">
            <div className="container mx-auto px-4 text-center text-sm">
              <p>&copy; 2026 COC Explorer | ChainID: 18780</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  )
}

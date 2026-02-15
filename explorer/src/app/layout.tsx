import type { Metadata } from "next"
import Link from "next/link"
import "./globals.css"
import { ConnectionStatus } from "@/components/ConnectionStatus"
import { SearchBar } from "@/components/SearchBar"

export const metadata: Metadata = {
  title: "COC Explorer - ChainOfClaw Block Explorer",
  description: "Explore blocks, transactions, and addresses on the COC blockchain",
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
            <div className="container mx-auto px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center space-x-6">
                  <Link href="/" className="text-2xl font-bold hover:text-blue-200 whitespace-nowrap">
                    COC Explorer
                  </Link>
                  <nav className="hidden sm:flex items-center space-x-4 text-sm">
                    <Link href="/" className="hover:text-blue-200">Blocks</Link>
                    <Link href="/mempool" className="hover:text-blue-200">Mempool</Link>
                    <Link href="/contracts" className="hover:text-blue-200">Contracts</Link>
                    <Link href="/validators" className="hover:text-blue-200">Validators</Link>
                    <Link href="/stats" className="hover:text-blue-200">Stats</Link>
                    <Link href="/network" className="hover:text-blue-200">Network</Link>
                  </nav>
                </div>
                <SearchBar />
                <ConnectionStatus />
              </div>
            </div>
          </header>
          <main className="flex-1 container mx-auto px-4 py-8">
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

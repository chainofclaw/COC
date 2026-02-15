import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { routing } from '@/i18n/routing'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { Link } from '@/i18n/routing'
import './globals.css'

export const metadata: Metadata = {
  title: 'COC - ChainOfClaw | AI-Agent–Operated Blockchain',
  description:
    'COC (ChainOfClaw) is a Proof-of-Service blockchain network designed for broad, durable node participation by ordinary users with AI-agent operations.',
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  // Ensure that the incoming `locale` is valid
  if (!routing.locales.includes(locale as any)) {
    notFound()
  }

  const messages = await getMessages()

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <div className="min-h-screen flex flex-col bg-gray-50">
            {/* Header */}
            <header className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white shadow-lg">
              <div className="container mx-auto px-4 py-4">
                <div className="flex items-center justify-between gap-4">
                  <Link href="/" className="text-2xl font-bold hover:text-blue-200 transition">
                    COC
                  </Link>
                  <nav className="hidden md:flex items-center space-x-6">
                    <Link href="/" className="hover:text-blue-200 transition">
                      Home
                    </Link>
                    <Link href="/plan" className="hover:text-blue-200 transition">
                      Plan
                    </Link>
                    <Link href="/technology" className="hover:text-blue-200 transition">
                      Technology
                    </Link>
                    <Link href="/network" className="hover:text-blue-200 transition">
                      Network
                    </Link>
                    <Link href="/roadmap" className="hover:text-blue-200 transition">
                      Roadmap
                    </Link>
                    <Link href="/docs" className="hover:text-blue-200 transition">
                      Docs
                    </Link>
                    <a
                      href="http://localhost:3000"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-white text-blue-600 px-4 py-2 rounded-lg font-semibold hover:bg-blue-50 transition"
                    >
                      Explorer
                    </a>
                  </nav>
                  <div className="flex items-center gap-3">
                    <LanguageSwitcher />
                    {/* Mobile menu button */}
                    <button className="md:hidden text-white">
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 6h16M4 12h16M4 18h16"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </header>

            {/* Main content */}
            <main className="flex-1">{children}</main>

            {/* Footer */}
            <footer className="bg-gray-900 text-gray-300">
              <div className="container mx-auto px-4 py-8">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
                  <div>
                    <h3 className="text-white font-bold text-lg mb-4">COC</h3>
                    <p className="text-sm">
                      AI-Agent–Operated
                      <br />
                      Proof-of-Service Blockchain
                    </p>
                  </div>
                  <div>
                    <h4 className="text-white font-semibold mb-4">Resources</h4>
                    <ul className="space-y-2 text-sm">
                      <li>
                        <Link href="/docs" className="hover:text-white transition">
                          Documentation
                        </Link>
                      </li>
                      <li>
                        <Link href="/plan" className="hover:text-white transition">
                          Whitepaper
                        </Link>
                      </li>
                      <li>
                        <a
                          href="http://localhost:3000"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-white transition"
                        >
                          Block Explorer
                        </a>
                      </li>
                    </ul>
                  </div>
                  <div>
                    <h4 className="text-white font-semibold mb-4">Development</h4>
                    <ul className="space-y-2 text-sm">
                      <li>
                        <a href="https://github.com/openclaw/openclaw" className="hover:text-white transition">
                          GitHub
                        </a>
                      </li>
                      <li>
                        <Link href="/technology" className="hover:text-white transition">
                          Technical Architecture
                        </Link>
                      </li>
                      <li>
                        <Link href="/network" className="hover:text-white transition">
                          Network Status
                        </Link>
                      </li>
                    </ul>
                  </div>
                  <div>
                    <h4 className="text-white font-semibold mb-4">Community</h4>
                    <ul className="space-y-2 text-sm">
                      <li>
                        <a href="#" className="hover:text-white transition">
                          Discord
                        </a>
                      </li>
                      <li>
                        <a href="#" className="hover:text-white transition">
                          Twitter
                        </a>
                      </li>
                      <li>
                        <a href="#" className="hover:text-white transition">
                          Telegram
                        </a>
                      </li>
                    </ul>
                  </div>
                </div>
                <div className="border-t border-gray-800 mt-8 pt-6 text-center text-sm">
                  <p>&copy; 2026 ChainOfClaw. All rights reserved.</p>
                </div>
              </div>
            </footer>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}

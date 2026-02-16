import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { routing } from '@/i18n/routing'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { WalletProvider } from '@/components/shared/WalletProvider'
import { WalletConnect } from '@/components/identity/WalletConnect'
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
          <WalletProvider>
          <div className="min-h-screen flex flex-col bg-bg-primary">
            {/* Header */}
            <header className="sticky top-0 z-50 bg-bg-secondary/95 backdrop-blur-lg border-b border-text-muted/10">
              <div className="container mx-auto px-4 py-4">
                <div className="flex items-center justify-between gap-4">
                  {/* Logo */}
                  <Link
                    href="/"
                    className="group flex items-center gap-2 text-2xl font-display font-bold hover:text-accent-cyan transition-colors"
                  >
                    <div className="w-8 h-8 rounded-lg bg-gradient-cyber flex items-center justify-center group-hover:shadow-glow-md transition-shadow">
                      <span className="text-white text-lg">C</span>
                    </div>
                    <span className="gradient-text">COC</span>
                  </Link>

                  {/* Desktop Navigation */}
                  <nav className="hidden md:flex items-center space-x-1">
                    <NavLink href="/">Home</NavLink>
                    <NavLink href="/plan">Plan</NavLink>
                    <NavLink href="/technology">Technology</NavLink>
                    <NavLink href="/network">Network</NavLink>
                    <NavLink href="/roadmap">Roadmap</NavLink>
                    <NavLink href="/governance">Governance</NavLink>
                    <NavLink href="/forum">Forum</NavLink>
                    <NavLink href="/docs">Docs</NavLink>
                    <a
                      href="http://localhost:3000"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 px-4 py-2 rounded-lg bg-gradient-cyber text-white font-display font-semibold hover:shadow-glow-md transition-all hover:scale-105"
                    >
                      Explorer
                    </a>
                  </nav>

                  {/* Right Section */}
                  <div className="flex items-center gap-3">
                    <div className="hidden md:block">
                      <WalletConnect />
                    </div>
                    <LanguageSwitcher />
                    {/* Mobile menu button */}
                    <button className="md:hidden text-text-primary hover:text-accent-cyan transition-colors">
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
            <footer className="relative bg-bg-secondary border-t border-text-muted/10">
              <div className="noise-texture">
                <div className="container mx-auto px-4 py-12">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
                    {/* Brand Section */}
                    <div>
                      <div className="flex items-center gap-2 mb-4">
                        <div className="w-8 h-8 rounded-lg bg-gradient-cyber flex items-center justify-center">
                          <span className="text-white text-lg font-display">C</span>
                        </div>
                        <h3 className="text-text-primary font-display font-bold text-lg">COC</h3>
                      </div>
                      <p className="text-text-secondary text-sm leading-relaxed">
                        AI-Agent–Operated
                        <br />
                        Proof-of-Service Blockchain
                      </p>
                    </div>

                    {/* Resources */}
                    <div>
                      <h4 className="text-text-primary font-display font-semibold mb-4">Resources</h4>
                      <ul className="space-y-2">
                        <FooterLink href="/docs">Documentation</FooterLink>
                        <FooterLink href="/plan">Whitepaper</FooterLink>
                        <FooterLink href="http://localhost:3000" external>
                          Block Explorer
                        </FooterLink>
                      </ul>
                    </div>

                    {/* Development */}
                    <div>
                      <h4 className="text-text-primary font-display font-semibold mb-4">Development</h4>
                      <ul className="space-y-2">
                        <FooterLink href="https://github.com/openclaw/openclaw" external>
                          GitHub
                        </FooterLink>
                        <FooterLink href="/technology">Technical Architecture</FooterLink>
                        <FooterLink href="/network">Network Status</FooterLink>
                      </ul>
                    </div>

                    {/* Community */}
                    <div>
                      <h4 className="text-text-primary font-display font-semibold mb-4">Community</h4>
                      <ul className="space-y-2">
                        <FooterLink href="#">Discord</FooterLink>
                        <FooterLink href="#">Twitter</FooterLink>
                        <FooterLink href="#">Telegram</FooterLink>
                      </ul>
                    </div>
                  </div>

                  {/* Bottom Bar */}
                  <div className="border-t border-text-muted/10 pt-6">
                    <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                      <p className="text-text-muted text-sm font-body">
                        &copy; 2026 ChainOfClaw. All rights reserved.
                      </p>
                      <div className="flex items-center gap-4 text-text-muted text-sm">
                        <span className="font-display">&gt; BLOCKCHAIN_PROTOCOL_v0.2</span>
                        <div className="w-2 h-2 bg-accent-cyan rounded-full animate-pulse" />
                        <span className="font-display">NETWORK_ACTIVE</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </footer>
          </div>
          </WalletProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}

// Navigation Link Component
function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-4 py-2 rounded-lg font-body text-sm text-text-secondary hover:text-accent-cyan hover:bg-accent-cyan/5 transition-all"
    >
      {children}
    </Link>
  )
}

// Footer Link Component
function FooterLink({
  href,
  children,
  external,
}: {
  href: string
  children: React.ReactNode
  external?: boolean
}) {
  const className =
    'group flex items-center gap-2 text-text-secondary hover:text-accent-cyan transition-colors text-sm'

  if (external) {
    return (
      <li>
        <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
          <span className="inline-block group-hover:translate-x-1 transition-transform">&gt;</span>
          {children}
        </a>
      </li>
    )
  }

  return (
    <li>
      <Link href={href} className={className}>
        <span className="inline-block group-hover:translate-x-1 transition-transform">&gt;</span>
        {children}
      </Link>
    </li>
  )
}

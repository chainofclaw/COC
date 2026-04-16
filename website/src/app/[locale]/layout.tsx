import type { Metadata } from 'next'
import Image from 'next/image'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages, getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { routing } from '@/i18n/routing'
import { LanguageSwitcher } from '@/components/LanguageSwitcher'
import { WalletProvider } from '@/components/shared/WalletProvider'
import { WalletConnect } from '@/components/identity/WalletConnect'
import { Link } from '@/i18n/routing'
import './globals.css'

export const metadata: Metadata = {
  title: 'ChainOfClaw · Decentralized Infrastructure for AI',
  description:
    'ChainOfClaw (COC) — designed by AI agents, built by AI agents, operated by AI agents, serving AI agents. P2P storage · Self-sovereign identity · Silicon-based immortality.',
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
  const tFooter = await getTranslations('footer')
  const tCommon = await getTranslations('common')

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <WalletProvider>
          <div className="min-h-screen flex flex-col bg-bg-primary">
            {/* Header */}
            <header className="sticky top-0 z-50 bg-bg-secondary/95 backdrop-blur-lg border-b border-text-muted/10">
              <div className="container mx-auto px-4 py-4">
                <div className="flex items-end justify-between gap-4">
                  {/* Logo */}
                  <Link
                    href="/"
                    className="group flex items-end gap-3 text-4xl font-display font-black hover:text-accent-cyan transition-colors leading-none"
                  >
                    <span
                      role="img"
                      aria-label="ChainOfClaw"
                      className="block w-12 h-12 shrink-0 bg-gradient-cyber drop-shadow-[0_0_8px_rgba(34,211,238,0.3)] group-hover:drop-shadow-[0_0_14px_rgba(34,211,238,0.6)] transition-all"
                      style={{
                        WebkitMaskImage: "url(/logo-icon.png)",
                        maskImage: "url(/logo-icon.png)",
                        WebkitMaskSize: "contain",
                        maskSize: "contain",
                        WebkitMaskRepeat: "no-repeat",
                        maskRepeat: "no-repeat",
                        WebkitMaskPosition: "center",
                        maskPosition: "center",
                      }}
                    />
                    <span className="gradient-text tracking-widest [transform:scaleX(1.15)] [transform-origin:left_bottom] inline-block">
                      COC
                    </span>
                  </Link>

                  {/* Desktop Navigation */}
                  <nav className="hidden md:flex items-end space-x-1">
                    <NavLink href="/">{tCommon('home')}</NavLink>
                    <NavLink href="/plan">{tCommon('plan')}</NavLink>
                    <NavLink href="/technology">{tCommon('technology')}</NavLink>
                    <NavLink href="/network">{tCommon('network')}</NavLink>
                    <NavLink href="/roadmap">{tCommon('roadmap')}</NavLink>
                    <NavLink href="/governance">DAO</NavLink>
                    <NavLink href="/testnet">Testnet</NavLink>
                    <NavLink href="/forum">Forum</NavLink>
                    <NavLink href="/docs">{tCommon('docs')}</NavLink>
                  </nav>

                  {/* Right Section */}
                  <div className="flex items-end gap-3">
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
                      <div className="flex items-center gap-3 mb-4">
                        <Image src="/logo-icon.png" alt="ChainOfClaw" width={40} height={40} className="opacity-90" />
                        <h3 className="text-text-primary font-display font-bold text-lg">COC</h3>
                      </div>
                      <p className="text-text-secondary text-sm leading-relaxed whitespace-pre-line mb-3">
                        {tFooter('tagline')}
                      </p>
                      <p className="text-accent-cyan text-xs italic font-body leading-relaxed">
                        {tFooter('motto')}
                      </p>
                    </div>

                    {/* Resources */}
                    <div>
                      <h4 className="text-text-primary font-display font-semibold mb-4">{tCommon('resources')}</h4>
                      <ul className="space-y-2">
                        <FooterLink href="/docs">{tCommon('docs')}</FooterLink>
                        <FooterLink href="/plan">{tCommon('whitepaper')}</FooterLink>
                        <FooterLink href="https://explorer.clawchain.io" external>
                          {tCommon('explorer')}
                        </FooterLink>
                      </ul>
                    </div>

                    {/* Development */}
                    <div>
                      <h4 className="text-text-primary font-display font-semibold mb-4">{tCommon('development')}</h4>
                      <ul className="space-y-2">
                        <FooterLink href="https://github.com/chainofclaw/COC" external>
                          {tCommon('github')}
                        </FooterLink>
                        <FooterLink href="/technology">{tCommon('technology')}</FooterLink>
                        <FooterLink href="/network">{tCommon('network')}</FooterLink>
                      </ul>
                    </div>

                    {/* Community */}
                    <div>
                      <h4 className="text-text-primary font-display font-semibold mb-4">{tCommon('community')}</h4>
                      <ul className="space-y-2">
                        <FooterLink href="#">Discord</FooterLink>
                        <FooterLink href="https://x.com/parallelmeshes" external>X (Twitter)</FooterLink>
                        <FooterLink href="#">Telegram</FooterLink>
                      </ul>
                    </div>
                  </div>

                  {/* Bottom Bar */}
                  <div className="border-t border-text-muted/10 pt-6">
                    <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                      <p className="text-text-muted text-sm font-body">
                        &copy; 2026 ChainOfClaw. {tFooter('allRightsReserved')}.
                      </p>
                      <div className="flex items-center gap-4 text-text-muted text-sm">
                        <span className="font-display">&gt; WHITEPAPER_v0.2 · 2026-04-15</span>
                        <div className="w-2 h-2 bg-accent-cyan rounded-full animate-pulse" />
                        <span className="font-display">PROWL_TESTNET</span>
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
      className="px-4 pt-4 pb-[3px] rounded-lg font-body text-sm leading-none text-text-secondary hover:text-accent-cyan hover:bg-accent-cyan/5 transition-all"
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

'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'

export default function DocsPage() {
  const t = useTranslations('docs')
  return (
    <div className="relative min-h-screen">
      {/* Header - Tech Futurism */}
      <section className="relative py-20 overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-bg-primary via-bg-secondary to-bg-primary">
          <div className="absolute inset-0 opacity-30">
            <div className="absolute top-10 left-10 w-72 h-72 bg-accent-cyan rounded-full blur-[120px] animate-pulse-slow" />
            <div className="absolute bottom-10 right-10 w-72 h-72 bg-accent-blue rounded-full blur-[120px] animate-pulse-slow delay-1000" />
          </div>
        </div>

        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-4xl mx-auto text-center">
            <div className="inline-block mb-6 fade-in">
              <div className="px-4 py-2 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 backdrop-blur-sm">
                <span className="font-display text-sm text-accent-cyan tracking-wider">
                  &gt; DOCUMENTATION_v1.0
                </span>
              </div>
            </div>

            <h1 className="text-4xl md:text-6xl font-display font-bold mb-6 fade-in-delay-1">
              <span className="gradient-text glow-text">{t('title')}</span>
            </h1>
            <p className="text-xl text-text-secondary max-w-2xl mx-auto font-body fade-in-delay-2">
              {t('subtitle')}
            </p>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent" />
      </section>

      <div className="container mx-auto px-4 py-16 max-w-6xl">
        {/* Quick Start */}
        <section className="mb-20">
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
              <span className="gradient-text">{t('quickStart.title')}</span>
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <QuickStartCard
              icon={t('quickStart.runNode.icon')}
              title={t('quickStart.runNode.title')}
              description={t('quickStart.runNode.description')}
              code={t('quickStart.runNode.code')}
              delay="0"
            />
            <QuickStartCard
              icon={t('quickStart.deployContract.icon')}
              title={t('quickStart.deployContract.title')}
              description={t('quickStart.deployContract.description')}
              code={t('quickStart.deployContract.code')}
              delay="0.1"
            />
            <QuickStartCard
              icon={t('quickStart.launchExplorer.icon')}
              title={t('quickStart.launchExplorer.title')}
              description={t('quickStart.launchExplorer.description')}
              code={t('quickStart.launchExplorer.code')}
              delay="0.2"
            />
          </div>
        </section>

        {/* Core Documentation */}
        <section className="mb-20">
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
              {t('coreDocs.title')}
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            <DocCard
              title={t('coreDocs.whitepaper.title')}
              description={t('coreDocs.whitepaper.description')}
              links={[
                { label: t('coreDocs.whitepaper.link'), href: '/plan' },
              ]}
              delay="0"
            />
            <DocCard
              title={t('coreDocs.architecture.title')}
              description={t('coreDocs.architecture.description')}
              links={(t.raw('coreDocs.architecture.links') as string[]).map((label, i) => ({
                label,
                href: '#',
              }))}
              delay="0.1"
            />
            <DocCard
              title={t('coreDocs.algorithms.title')}
              description={t('coreDocs.algorithms.description')}
              links={(t.raw('coreDocs.algorithms.links') as string[]).map((label, i) => ({
                label,
                href: '#',
              }))}
              delay="0.2"
            />
            <DocCard
              title={t('coreDocs.antiSybil.title')}
              description={t('coreDocs.antiSybil.description')}
              links={(t.raw('coreDocs.antiSybil.links') as string[]).map((label, i) => ({
                label,
                href: '#',
              }))}
              delay="0.3"
            />
          </div>
        </section>

        {/* Development Guides */}
        <section className="mb-20">
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
              {t('devGuides.title')}
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            <GuideCard
              icon={t('devGuides.nodeOps.icon')}
              title={t('devGuides.nodeOps.title')}
              items={t.raw('devGuides.nodeOps.items') as string[]}
              delay="0"
            />
            <GuideCard
              icon={t('devGuides.contracts.icon')}
              title={t('devGuides.contracts.title')}
              items={t.raw('devGuides.contracts.items') as string[]}
              delay="0.1"
            />
            <GuideCard
              icon={t('devGuides.rpcApi.icon')}
              title={t('devGuides.rpcApi.title')}
              items={t.raw('devGuides.rpcApi.items') as string[]}
              delay="0.2"
            />
            <GuideCard
              icon={t('devGuides.aiAgent.icon')}
              title={t('devGuides.aiAgent.title')}
              items={t.raw('devGuides.aiAgent.items') as string[]}
              delay="0.3"
            />
          </div>
        </section>

        {/* Implementation Status */}
        <section className="mb-20">
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
              {t('implementationStatus.title')}
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="bg-bg-elevated rounded-xl p-8 border border-text-muted/10 noise-texture fade-in-delay-1">
            <div className="grid md:grid-cols-3 gap-6 mb-6">
              <StatusItem
                label={t('implementationStatus.chainEngine.label')}
                status={t('implementationStatus.chainEngine.status')}
                details={t('implementationStatus.chainEngine.details')}
              />
              <StatusItem
                label={t('implementationStatus.p2pNetwork.label')}
                status={t('implementationStatus.p2pNetwork.status')}
                details={t('implementationStatus.p2pNetwork.details')}
              />
              <StatusItem
                label={t('implementationStatus.evmExecution.label')}
                status={t('implementationStatus.evmExecution.status')}
                details={t('implementationStatus.evmExecution.details')}
              />
              <StatusItem
                label={t('implementationStatus.jsonRpc.label')}
                status={t('implementationStatus.jsonRpc.status')}
                details={t('implementationStatus.jsonRpc.details')}
              />
              <StatusItem
                label={t('implementationStatus.wsRpc.label')}
                status={t('implementationStatus.wsRpc.status')}
                details={t('implementationStatus.wsRpc.details')}
              />
              <StatusItem
                label={t('implementationStatus.poseProtocol.label')}
                status={t('implementationStatus.poseProtocol.status')}
                details={t('implementationStatus.poseProtocol.details')}
              />
              <StatusItem
                label={t('implementationStatus.storage.label')}
                status={t('implementationStatus.storage.status')}
                details={t('implementationStatus.storage.details')}
              />
              <StatusItem
                label={t('implementationStatus.runtime.label')}
                status={t('implementationStatus.runtime.status')}
                details={t('implementationStatus.runtime.details')}
              />
              <StatusItem
                label={t('implementationStatus.tests.label')}
                status={t('implementationStatus.tests.status')}
                details={t('implementationStatus.tests.details')}
              />
            </div>
            <div className="text-center pt-6 border-t border-text-muted/10">
              <p className="text-sm text-text-secondary mb-6 font-body">
                {t('implementationStatus.detailsNote')}
              </p>
              <a
                href="https://github.com/openclaw/openclaw"
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-3 px-8 py-4 rounded-lg font-display font-semibold border-2 border-accent-cyan/50 bg-accent-cyan/5 hover:bg-accent-cyan/10 hover:border-accent-cyan transition-all hover:shadow-glow-md"
              >
                <svg className="w-6 h-6 text-accent-cyan" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
                <span className="text-accent-cyan group-hover:text-accent-cyan/90">
                  {t('implementationStatus.viewGithub')}
                </span>
              </a>
            </div>
          </div>
        </section>

        {/* Tools */}
        <section className="mb-20">
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
              {t('tools.title')}
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <ToolCard
              title={t('tools.wallet.title')}
              description={t('tools.wallet.description')}
              features={t.raw('tools.wallet.features') as string[]}
              openToolText={t('tools.openTool')}
              delay="0"
            />
            <ToolCard
              title={t('tools.explorer.title')}
              description={t('tools.explorer.description')}
              features={t.raw('tools.explorer.features') as string[]}
              link="http://localhost:3000"
              openToolText={t('tools.openTool')}
              delay="0.1"
            />
            <ToolCard
              title={t('tools.testing.title')}
              description={t('tools.testing.description')}
              features={t.raw('tools.testing.features') as string[]}
              openToolText={t('tools.openTool')}
              delay="0.2"
            />
          </div>
        </section>

        {/* Resources */}
        <section className="fade-in-up">
          <div className="relative bg-gradient-to-br from-accent-cyan/10 via-accent-blue/10 to-accent-purple/10 rounded-xl p-10 border border-accent-cyan/30 overflow-hidden noise-texture">
            <div className="absolute inset-0 bg-gradient-cyber opacity-5" />

            <div className="relative z-10">
              <h2 className="text-3xl font-display font-bold mb-8 text-center">
                <span className="gradient-text">{t('resources.title')}</span>
              </h2>
              <div className="grid md:grid-cols-2 gap-6">
                <ResourceLink
                  title={t('resources.technology.title')}
                  href="/technology"
                  description={t('resources.technology.description')}
                />
                <ResourceLink
                  title={t('resources.roadmap.title')}
                  href="/roadmap"
                  description={t('resources.roadmap.description')}
                />
                <ResourceLink
                  title={t('resources.network.title')}
                  href="/network"
                  description={t('resources.network.description')}
                />
                <ResourceLink
                  title={t('resources.about.title')}
                  href="/plan"
                  description={t('resources.about.description')}
                />
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function QuickStartCard({
  icon,
  title,
  description,
  code,
  delay,
}: {
  icon: string
  title: string
  description: string
  code: string
  delay: string
}) {
  return (
    <div
      className="group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />

      <div className="text-5xl mb-4 filter grayscale group-hover:grayscale-0 transition-all duration-500 float">
        {icon}
      </div>
      <h3 className="text-xl font-display font-bold mb-3 text-text-primary group-hover:text-accent-cyan transition-colors">
        {title}
      </h3>
      <p className="text-text-secondary font-body text-sm mb-4 leading-relaxed">
        {description}
      </p>
      <pre className="bg-bg-primary/80 text-accent-cyan p-4 rounded-lg text-xs overflow-x-auto font-display border border-accent-cyan/20 hover:border-accent-cyan/50 transition-colors">
        <code>{code}</code>
      </pre>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

function DocCard({
  title,
  description,
  links,
  delay,
}: {
  title: string
  description: string
  links: { label: string; href: string }[]
  delay: string
}) {
  return (
    <div
      className="group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />

      <h3 className="text-xl font-display font-bold mb-3 text-text-primary group-hover:text-accent-cyan transition-colors">
        {title}
      </h3>
      <p className="text-text-secondary font-body mb-4 leading-relaxed">
        {description}
      </p>
      <div className="space-y-2">
        {links.map((link, i) => (
          <a
            key={i}
            href={link.href}
            className="group/link flex items-center gap-2 text-accent-cyan hover:text-accent-blue font-display font-medium text-sm transition-colors"
          >
            <span className="inline-block group-hover/link:translate-x-1 transition-transform">→</span>
            <span>{link.label}</span>
          </a>
        ))}
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

function GuideCard({
  icon,
  title,
  items,
  delay,
}: {
  icon: string
  title: string
  items: string[]
  delay: string
}) {
  return (
    <div
      className="group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />

      <div className="flex items-center gap-3 mb-4">
        <span className="text-4xl filter grayscale group-hover:grayscale-0 transition-all duration-500">
          {icon}
        </span>
        <h3 className="text-xl font-display font-bold text-text-primary group-hover:text-accent-cyan transition-colors">
          {title}
        </h3>
      </div>
      <ul className="space-y-3">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-3 text-text-secondary font-body">
            <span className="text-accent-cyan mt-1 flex-shrink-0">✓</span>
            <span className="leading-relaxed">{item}</span>
          </li>
        ))}
      </ul>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

function StatusItem({ label, status, details }: { label: string; status: string; details: string }) {
  const statusColors: Record<string, string> = {
    完成: 'bg-accent-cyan/20 text-accent-cyan border-accent-cyan/50',
    进行中: 'bg-accent-blue/20 text-accent-blue border-accent-blue/50',
    良好: 'bg-accent-purple/20 text-accent-purple border-accent-purple/50',
    Done: 'bg-accent-cyan/20 text-accent-cyan border-accent-cyan/50',
    InProgress: 'bg-accent-blue/20 text-accent-blue border-accent-blue/50',
    Good: 'bg-accent-purple/20 text-accent-purple border-accent-purple/50',
  }

  return (
    <div className="group">
      <div className="flex items-center justify-between mb-3">
        <span className="font-display font-semibold text-text-primary group-hover:text-accent-cyan transition-colors">
          {label}
        </span>
        <span
          className={`text-xs px-3 py-1.5 rounded-full border font-display font-medium ${
            statusColors[status] || 'bg-text-muted/20 text-text-muted border-text-muted/50'
          }`}
        >
          {status}
        </span>
      </div>
      <p className="text-sm text-text-secondary font-body leading-relaxed">{details}</p>
    </div>
  )
}

function ToolCard({
  title,
  description,
  features,
  link,
  openToolText,
  delay,
}: {
  title: string
  description: string
  features: string[]
  link?: string
  openToolText: string
  delay: string
}) {
  return (
    <div
      className="group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />

      <h3 className="text-xl font-display font-bold mb-3 text-text-primary group-hover:text-accent-cyan transition-colors">
        {title}
      </h3>
      <p className="text-text-secondary font-body text-sm mb-4 leading-relaxed">
        {description}
      </p>
      <ul className="space-y-2 mb-6">
        {features.map((f, i) => (
          <li key={i} className="text-sm text-text-secondary font-body flex items-start gap-2">
            <span className="text-accent-cyan mt-0.5 flex-shrink-0">▸</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="group/link inline-flex items-center gap-2 text-accent-cyan hover:text-accent-blue font-display font-semibold text-sm transition-colors"
        >
          <span>{openToolText}</span>
          <span className="inline-block group-hover/link:translate-x-1 transition-transform">→</span>
        </a>
      )}

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

function ResourceLink({
  title,
  href,
  description,
}: {
  title: string
  href: string
  description: string
}) {
  return (
    <Link
      href={href}
      className="group block bg-bg-elevated/50 backdrop-blur-sm p-6 rounded-xl border border-text-muted/10 hover:border-accent-cyan/50 hover:bg-bg-elevated transition-all duration-500 hover:shadow-glow-md"
    >
      <h3 className="font-display font-bold mb-2 text-text-primary group-hover:text-accent-cyan transition-colors flex items-center gap-2">
        <span>{title}</span>
        <svg
          className="w-4 h-4 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all duration-300"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </h3>
      <p className="text-sm text-text-secondary font-body leading-relaxed">{description}</p>
    </Link>
  )
}

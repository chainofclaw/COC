'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'
import { NetworkStats } from '@/components/NetworkStats'

export default function HomePage() {
  const t = useTranslations('home')

  return (
    <div className="relative">
      {/* Hero Section - Tech Futurism */}
      <section className="relative min-h-[90vh] flex items-center overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-bg-primary via-bg-secondary to-bg-primary">
          <div className="absolute inset-0 opacity-30">
            <div className="absolute top-20 left-10 w-96 h-96 bg-accent-cyan rounded-full blur-[120px] animate-pulse-slow" />
            <div className="absolute bottom-20 right-10 w-96 h-96 bg-accent-blue rounded-full blur-[120px] animate-pulse-slow delay-1000" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-accent-purple rounded-full blur-[120px] animate-pulse-slow delay-2000" />
          </div>
        </div>

        <div className="container mx-auto px-4 py-20 relative z-10">
          <div className="max-w-5xl mx-auto">
            {/* Pre-title */}
            <div className="inline-block mb-6 fade-in">
              <div className="px-4 py-2 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 backdrop-blur-sm">
                <span className="font-display text-sm text-accent-cyan tracking-wider">
                  &gt; BLOCKCHAIN_PROTOCOL_v0.2
                </span>
              </div>
            </div>

            {/* Main Title */}
            <h1 className="text-5xl md:text-7xl font-display font-bold mb-8 leading-tight whitespace-pre-line fade-in-delay-1">
              <span className="gradient-text glow-text">{t('hero.title')}</span>
            </h1>

            {/* Subtitle */}
            <p className="text-xl md:text-2xl mb-12 text-text-secondary max-w-3xl font-body fade-in-delay-2">
              {t('hero.subtitle')}
            </p>

            {/* CTA Buttons */}
            <div className="flex flex-col sm:flex-row gap-4 fade-in-delay-3">
              <Link
                href="/plan"
                className="group relative px-8 py-4 rounded-lg font-display font-semibold text-lg overflow-hidden transition-all hover:scale-105"
              >
                <div className="absolute inset-0 bg-gradient-cyber opacity-100 group-hover:opacity-90 transition-opacity" />
                <div className="absolute inset-0 bg-gradient-cyber blur-xl opacity-50 group-hover:opacity-75 transition-opacity" />
                <span className="relative text-white">&gt; {t('hero.learnMore')}</span>
              </Link>

              <a
                href="http://localhost:3000"
                target="_blank"
                rel="noopener noreferrer"
                className="group px-8 py-4 rounded-lg font-display font-semibold text-lg border-2 border-accent-cyan/50 bg-accent-cyan/5 hover:bg-accent-cyan/10 hover:border-accent-cyan transition-all hover:shadow-glow-md backdrop-blur-sm"
              >
                <span className="text-accent-cyan group-hover:text-accent-cyan/90">
                  {t('hero.browseBlockchain')} →
                </span>
              </a>

              <Link
                href="/docs"
                className="group px-8 py-4 rounded-lg font-display font-semibold text-lg border-2 border-text-muted/30 hover:border-text-secondary/50 transition-all hover:bg-bg-elevated/50 backdrop-blur-sm"
              >
                <span className="text-text-secondary group-hover:text-text-primary">
                  {t('hero.readDocs')}
                </span>
              </Link>
            </div>

            {/* Decorative Code Lines */}
            <div className="mt-16 font-display text-sm text-text-muted/50 space-y-1 fade-in-delay-3">
              <div className="data-flow">
                <span className="text-accent-cyan">$</span> npm install @coc/node
              </div>
              <div className="data-flow" style={{ animationDelay: '0.5s' }}>
                <span className="text-accent-blue">$</span> coc node start --network mainnet
              </div>
              <div className="data-flow" style={{ animationDelay: '1s' }}>
                <span className="text-accent-purple">✓</span> Node synchronized • Block height: 1,234,567
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Glow Line */}
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent" />
      </section>

      {/* Network Stats Section */}
      <section className="py-16 relative">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
              <span className="gradient-text">{t('networkStats.title')}</span>
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="fade-in-delay-1">
            <NetworkStats />
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 relative">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">
              {t('features.title')}
            </h2>
            <p className="text-text-secondary max-w-2xl mx-auto font-body">
              {t('features.subtitle')}
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            <FeatureCard
              icon="🎯"
              title={t('features.pose.title')}
              description={t('features.pose.description')}
              delay="0"
            />
            <FeatureCard
              icon="🤖"
              title={t('features.aiAgent.title')}
              description={t('features.aiAgent.description')}
              delay="0.1"
            />
            <FeatureCard
              icon="💻"
              title={t('features.hardware.title')}
              description={t('features.hardware.description')}
              delay="0.2"
            />
            <FeatureCard
              icon="🔒"
              title={t('features.nonPos.title')}
              description={t('features.nonPos.description')}
              delay="0.3"
            />
            <FeatureCard
              icon="⚡"
              title={t('features.evmCompatible.title')}
              description={t('features.evmCompatible.description')}
              delay="0.4"
            />
            <FeatureCard
              icon="🌐"
              title={t('features.storage.title')}
              description={t('features.storage.description')}
              delay="0.5"
            />
          </div>
        </div>
      </section>

      {/* Architecture Overview */}
      <section className="py-20 relative">
        <div className="container mx-auto px-4">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-16 fade-in-up">
              <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">
                {t('architecture.title')}
              </h2>
            </div>

            <div className="space-y-6">
              <ArchitectureLayer
                number="1"
                title={t('architecture.layer1.title')}
                description={t('architecture.layer1.description')}
                color="cyan"
                delay="0"
              />
              <ArchitectureLayer
                number="2"
                title={t('architecture.layer2.title')}
                description={t('architecture.layer2.description')}
                color="blue"
                delay="0.1"
              />
              <ArchitectureLayer
                number="3"
                title={t('architecture.layer3.title')}
                description={t('architecture.layer3.description')}
                color="purple"
                delay="0.2"
              />
              <ArchitectureLayer
                number="4"
                title={t('architecture.layer4.title')}
                description={t('architecture.layer4.description')}
                color="pink"
                delay="0.3"
              />
            </div>

            <div className="text-center mt-12 fade-in-delay-3">
              <Link
                href="/technology"
                className="group inline-flex items-center gap-2 font-display text-accent-cyan hover:text-accent-blue transition-colors"
              >
                {t('architecture.learnMore')}
                <svg
                  className="w-5 h-5 group-hover:translate-x-1 transition-transform"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Node Roles */}
      <section className="py-20 relative">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">
              {t('nodeRoles.title')}
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            <NodeRoleCard
              icon="🖥️"
              title={t('nodeRoles.fullNode.title')}
              description={t('nodeRoles.fullNode.description')}
              reward={t('nodeRoles.fullNode.reward')}
              delay="0"
            />
            <NodeRoleCard
              icon="💾"
              title={t('nodeRoles.storageNode.title')}
              description={t('nodeRoles.storageNode.description')}
              reward={t('nodeRoles.storageNode.reward')}
              delay="0.2"
            />
            <NodeRoleCard
              icon="📡"
              title={t('nodeRoles.relayNode.title')}
              description={t('nodeRoles.relayNode.description')}
              reward={t('nodeRoles.relayNode.reward')}
              delay="0.4"
            />
          </div>

          <p className="text-center mt-12 text-text-secondary font-body fade-in-delay-3">
            {t('nodeRoles.note')}
          </p>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-accent-cyan/10 via-accent-blue/10 to-accent-purple/10" />
        <div className="absolute inset-0 noise-texture" />

        <div className="container mx-auto px-4 text-center relative z-10">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-3xl md:text-5xl font-display font-bold mb-6 fade-in-up">
              <span className="gradient-text">{t('cta.title')}</span>
            </h2>
            <p className="text-xl mb-12 text-text-secondary font-body fade-in-delay-1">
              {t('cta.subtitle')}
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center fade-in-delay-2">
              <Link
                href="/docs"
                className="group relative px-8 py-4 rounded-lg font-display font-semibold text-lg overflow-hidden transition-all hover:scale-105"
              >
                <div className="absolute inset-0 bg-gradient-cyber opacity-100 group-hover:opacity-90 transition-opacity" />
                <div className="absolute inset-0 bg-gradient-cyber blur-xl opacity-50 group-hover:opacity-75 transition-opacity" />
                <span className="relative text-white">&gt; {t('cta.startNode')}</span>
              </Link>

              <Link
                href="/network"
                className="group px-8 py-4 rounded-lg font-display font-semibold text-lg border-2 border-accent-cyan/50 bg-accent-cyan/5 hover:bg-accent-cyan/10 hover:border-accent-cyan transition-all hover:shadow-glow-md backdrop-blur-sm"
              >
                <span className="text-accent-cyan group-hover:text-accent-cyan/90">
                  {t('cta.viewNetwork')} →
                </span>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function FeatureCard({
  icon,
  title,
  description,
  delay,
}: {
  icon: string
  title: string
  description: string
  delay: string
}) {
  return (
    <div
      className="group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      {/* Hover Glow Effect */}
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />

      {/* Icon */}
      <div className="text-5xl mb-4 filter grayscale group-hover:grayscale-0 transition-all duration-500 float">
        {icon}
      </div>

      {/* Content */}
      <h3 className="text-xl font-display font-bold mb-3 text-text-primary group-hover:text-accent-cyan transition-colors">
        {title}
      </h3>
      <p className="text-text-secondary font-body leading-relaxed">{description}</p>

      {/* Bottom Border Accent */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

function ArchitectureLayer({
  number,
  title,
  description,
  color,
  delay,
}: {
  number: string
  title: string
  description: string
  color: string
  delay: string
}) {
  const colorMap: Record<string, { bg: string; text: string; border: string }> = {
    cyan: { bg: 'bg-accent-cyan/10', text: 'text-accent-cyan', border: 'border-accent-cyan/50' },
    blue: { bg: 'bg-accent-blue/10', text: 'text-accent-blue', border: 'border-accent-blue/50' },
    purple: { bg: 'bg-accent-purple/10', text: 'text-accent-purple', border: 'border-accent-purple/50' },
    pink: { bg: 'bg-pink-500/10', text: 'text-pink-400', border: 'border-pink-500/50' },
  }

  const colors = colorMap[color]

  return (
    <div
      className="group flex items-start gap-6 bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 noise-texture slide-in-right"
      style={{ animationDelay: `${delay}s` }}
    >
      {/* Number Badge */}
      <div
        className={`${colors.bg} ${colors.text} ${colors.border} border-2 rounded-lg w-14 h-14 flex items-center justify-center font-display font-bold text-xl flex-shrink-0 group-hover:scale-110 transition-transform duration-500`}
      >
        {number}
      </div>

      {/* Content */}
      <div className="flex-1">
        <h3 className="text-xl font-display font-bold mb-2 text-text-primary group-hover:text-accent-cyan transition-colors">
          {title}
        </h3>
        <p className="text-text-secondary font-body leading-relaxed">{description}</p>
      </div>
    </div>
  )
}

function NodeRoleCard({
  icon,
  title,
  description,
  reward,
  delay,
}: {
  icon: string
  title: string
  description: string
  reward: string
  delay: string
}) {
  return (
    <div
      className="group relative bg-bg-elevated rounded-xl p-8 text-center border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      {/* Hover Glow Effect */}
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />

      {/* Icon */}
      <div className="text-6xl mb-6 filter grayscale group-hover:grayscale-0 transition-all duration-500 inline-block float">
        {icon}
      </div>

      {/* Content */}
      <h3 className="text-xl font-display font-bold mb-3 text-text-primary group-hover:text-accent-cyan transition-colors">
        {title}
      </h3>
      <p className="text-text-secondary font-body leading-relaxed mb-6">{description}</p>

      {/* Reward Badge */}
      <div className="inline-block px-6 py-3 rounded-lg bg-accent-cyan/10 border border-accent-cyan/30 font-display font-semibold text-accent-cyan group-hover:bg-accent-cyan/20 group-hover:border-accent-cyan/50 transition-all duration-500">
        {reward}
      </div>
    </div>
  )
}

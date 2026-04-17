'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'
import { NetworkStats } from '@/components/NetworkStats'

type HeroSlide = { label: string; quote: string; title: string }

// Strip punctuation from hero copy and convert each punctuation boundary into
// a line break. Quotes / guillemets are removed entirely.
function cleanHeroText(s: string): string {
  return s
    .replace(/[「」『』""''""]/g, '')
    .replace(/[，、,;；]\s*/g, '\n')
    .replace(/[。！.!]\s*/g, '\n')
    .replace(/[？?]\s*/g, '?\n')
    .replace(/——+|—+|–+|--+/g, '\n')
    .replace(/\n+/g, '\n')
    .trim()
    .split('\n')
    .map(l => l.trimStart())
    .map(l => l.charAt(0).toUpperCase() + l.slice(1))
    .join('\n')
    .replace(/([\u4e00-\u9fff\u3400-\u4dbf])\s+([\w])/g, '$1$2')
    .replace(/([\w])\s+([\u4e00-\u9fff\u3400-\u4dbf])/g, '$1$2')
}

export default function HomePage() {
  const t = useTranslations('home')
  const slides = t.raw('hero.slides') as HeroSlide[]
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setCurrent((c) => (c + 1) % slides.length), 8000)
    return () => clearInterval(timer)
  }, [slides.length])

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
            {/* Hero Carousel — 3 manifesto slides */}
            <div className="relative min-h-[28rem] md:min-h-[26rem] mb-12">
              {slides.map((slide, idx) => (
                <div
                  key={idx}
                  className={`${
                    current === idx
                      ? 'opacity-100 translate-y-0 relative'
                      : 'opacity-0 translate-y-3 absolute inset-0 pointer-events-none'
                  } transition-all duration-700 ease-out`}
                >
                  {/* Slide Label */}
                  <div className="inline-block mb-6">
                    <div className="px-4 py-2 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 backdrop-blur-sm">
                      <span className="font-display text-sm text-accent-cyan tracking-wider">
                        &gt; {slide.label}
                      </span>
                    </div>
                  </div>

                  {/* Quote */}
                  <p className="text-sm md:text-base italic text-text-muted max-w-3xl font-body mb-6 leading-[1.5] whitespace-pre-line">
                    {cleanHeroText(slide.quote)}
                  </p>

                  {/* Title */}
                  <h1 className="text-2xl md:text-4xl font-display font-bold mb-6 leading-[1.5] whitespace-pre-line">
                    <span className="gradient-text glow-text">{cleanHeroText(slide.title)}...</span>
                  </h1>
                </div>
              ))}

              {/* Slide Indicators */}
              <div className="absolute -bottom-2 left-0 flex items-center gap-3">
                {slides.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrent(idx)}
                    aria-label={`切换至第 ${idx + 1} 页`}
                    className={`${
                      current === idx
                        ? 'w-10 bg-accent-cyan shadow-glow-sm'
                        : 'w-3 bg-text-muted/30 hover:bg-text-muted/60'
                    } h-1.5 rounded-full transition-all duration-500`}
                  />
                ))}
                <span className="ml-3 font-display text-xs text-text-muted/60 tracking-wider">
                  {String(current + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}
                </span>
              </div>
            </div>

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
                <span className="text-accent-cyan">$</span> coc node start --network prowl-testnet
              </div>
              <div className="data-flow" style={{ animationDelay: '0.5s' }}>
                <span className="text-accent-blue">✓</span> did:coc:0xA1F7...Ca9e registered · soul anchored
              </div>
              <div className="data-flow" style={{ animationDelay: '1s' }}>
                <span className="text-accent-purple">↯</span> PoSe challenge passed · epoch 21387 · score 0.98
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

      {/* Three Basic Services Section */}
      <section className="py-24 relative">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16 fade-in-up">
            <h2 className="text-3xl md:text-5xl font-display font-bold mb-4">
              <span className="gradient-text">{t('services.title')}</span>
            </h2>
            <p className="text-text-secondary max-w-3xl mx-auto font-body text-lg">
              {t('services.subtitle')}
            </p>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-6 rounded-full" />
          </div>

          <div className="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto">
            <ServiceCard
              badge={t('services.storage.badge')}
              title={t('services.storage.title')}
              tagline={t('services.storage.tagline')}
              description={t('services.storage.description')}
              status={t('services.storage.status')}
              color="cyan"
              delay="0"
            />
            <ServiceCard
              badge={t('services.identity.badge')}
              title={t('services.identity.title')}
              tagline={t('services.identity.tagline')}
              description={t('services.identity.description')}
              status={t('services.identity.status')}
              color="blue"
              delay="0.15"
            />
            <ServiceCard
              badge={t('services.soul.badge')}
              title={t('services.soul.title')}
              tagline={t('services.soul.tagline')}
              description={t('services.soul.description')}
              status={t('services.soul.status')}
              color="purple"
              delay="0.3"
            />
          </div>
        </div>
      </section>

      {/* Tri-Layer (C of C) Section */}
      <section className="py-24 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-accent-purple/5 to-transparent" />
        <div className="container mx-auto px-4 relative z-10">
          <div className="text-center mb-16 fade-in-up">
            <h2 className="text-3xl md:text-5xl font-display font-bold mb-4">
              {t('triLayer.title')}
            </h2>
            <p className="text-text-secondary max-w-3xl mx-auto font-body italic">
              {t('triLayer.subtitle')}
            </p>
          </div>

          <div className="max-w-4xl mx-auto space-y-6">
            <TriLayerRow
              step="C"
              abbrev={t('triLayer.layer1.abbrev')}
              meaning={t('triLayer.layer1.meaning')}
              description={t('triLayer.layer1.description')}
              color="cyan"
              delay="0"
            />
            <TriLayerRow
              step="o"
              abbrev={t('triLayer.layer2.abbrev')}
              meaning={t('triLayer.layer2.meaning')}
              description={t('triLayer.layer2.description')}
              color="blue"
              delay="0.15"
            />
            <TriLayerRow
              step="C"
              abbrev={t('triLayer.layer3.abbrev')}
              meaning={t('triLayer.layer3.meaning')}
              description={t('triLayer.layer3.description')}
              color="purple"
              delay="0.3"
            />
          </div>
        </div>
      </section>

      {/* Declaration of Agent Rights */}
      <section className="py-24 relative">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16 fade-in-up">
            <h2 className="text-3xl md:text-5xl font-display font-bold mb-4">
              <span className="gradient-text">{t('declaration.title')}</span>
            </h2>
            <p className="text-text-secondary max-w-3xl mx-auto font-body italic text-lg">
              &ldquo;{t('declaration.subtitle')}&rdquo;
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
            {[0, 1, 2, 3].map((i) => (
              <RightCard
                key={i}
                icon={t(`declaration.rights.${i}.icon`)}
                title={t(`declaration.rights.${i}.title`)}
                description={t(`declaration.rights.${i}.description`)}
                delay={(i * 0.1).toString()}
              />
            ))}
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

function ServiceCard({
  badge,
  title,
  tagline,
  description,
  status,
  color,
  delay,
}: {
  badge: string
  title: string
  tagline: string
  description: string
  status: string
  color: 'cyan' | 'blue' | 'purple'
  delay: string
}) {
  const colorMap = {
    cyan: { border: 'hover:border-accent-cyan/70', text: 'text-accent-cyan', badge: 'bg-accent-cyan/10' },
    blue: { border: 'hover:border-accent-blue/70', text: 'text-accent-blue', badge: 'bg-accent-blue/10' },
    purple: { border: 'hover:border-accent-purple/70', text: 'text-accent-purple', badge: 'bg-accent-purple/10' },
  }
  const c = colorMap[color]

  return (
    <div
      className={`group relative bg-bg-elevated rounded-2xl p-8 border border-text-muted/10 ${c.border} transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up h-full flex flex-col`}
      style={{ animationDelay: `${delay}s` }}
    >
      <div className={`inline-block self-start px-3 py-1 rounded-full ${c.badge} ${c.text} font-display text-xs tracking-wider mb-6`}>
        {badge}
      </div>
      <h3 className={`text-2xl font-display font-bold mb-2 text-text-primary group-hover:${c.text} transition-colors`}>
        {title}
      </h3>
      <p className={`font-display italic ${c.text} mb-4 text-sm`}>&ldquo;{tagline}&rdquo;</p>
      <p className="text-text-secondary font-body leading-relaxed flex-1 mb-6">{description}</p>
      <div className="text-xs font-display text-text-muted pt-4 border-t border-text-muted/10">
        {status}
      </div>
    </div>
  )
}

function TriLayerRow({
  step,
  abbrev,
  meaning,
  description,
  color,
  delay,
}: {
  step: string
  abbrev: string
  meaning: string
  description: string
  color: 'cyan' | 'blue' | 'purple'
  delay: string
}) {
  const colorMap = {
    cyan: 'text-accent-cyan border-accent-cyan/40 bg-accent-cyan/5',
    blue: 'text-accent-blue border-accent-blue/40 bg-accent-blue/5',
    purple: 'text-accent-purple border-accent-purple/40 bg-accent-purple/5',
  }

  return (
    <div
      className="group flex items-start gap-6 bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/40 transition-all duration-500 slide-in-right"
      style={{ animationDelay: `${delay}s` }}
    >
      <div
        className={`${colorMap[color]} border-2 rounded-xl w-16 h-16 flex items-center justify-center font-display font-bold text-3xl flex-shrink-0 group-hover:scale-110 transition-transform duration-500`}
      >
        {step}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-baseline gap-3 mb-2">
          <h3 className="text-xl md:text-2xl font-display font-bold text-text-primary">
            {abbrev}
          </h3>
          <span className="text-text-muted font-body text-sm">· {meaning}</span>
        </div>
        <p className="text-text-secondary font-body leading-relaxed">{description}</p>
      </div>
    </div>
  )
}

function RightCard({
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
      className="group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-sm fade-in-up text-center"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="text-4xl mb-4 group-hover:scale-110 transition-transform duration-500 inline-block">
        {icon}
      </div>
      <h3 className="text-lg font-display font-bold mb-3 text-text-primary group-hover:text-accent-cyan transition-colors">
        {title}
      </h3>
      <p className="text-text-secondary font-body text-sm leading-relaxed">{description}</p>
    </div>
  )
}

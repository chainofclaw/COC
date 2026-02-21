'use client'

import { useTranslations } from 'next-intl'

export default function RoadmapPage() {
  const t = useTranslations('roadmap')

  return (
    <div className="relative min-h-screen">
      {/* Hero Section - Tech Futurism */}
      <section className="relative py-20 overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-bg-primary via-bg-secondary to-bg-primary">
          <div className="absolute inset-0 opacity-30">
            <div className="absolute top-10 left-10 w-96 h-96 bg-accent-cyan rounded-full blur-[120px] animate-pulse-slow" />
            <div className="absolute bottom-10 right-10 w-96 h-96 bg-accent-purple rounded-full blur-[120px] animate-pulse-slow delay-1000" />
          </div>
        </div>

        <div className="container mx-auto px-4 relative z-10">
          <div className="max-w-5xl mx-auto">
            {/* Pre-title */}
            <div className="inline-block mb-6 fade-in">
              <div className="px-4 py-2 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 backdrop-blur-sm">
                <span className="font-display text-sm text-accent-cyan tracking-wider">
                  &gt; DEVELOPMENT_ROADMAP
                </span>
              </div>
            </div>

            {/* Title */}
            <h1 className="text-5xl md:text-6xl font-display font-bold mb-6 fade-in-delay-1">
              <span className="gradient-text glow-text">{t('title')}</span>
            </h1>
            <p className="text-xl text-text-secondary max-w-3xl font-body fade-in-delay-2">
              {t('subtitle')}
            </p>
          </div>
        </div>

        {/* Bottom Glow Line */}
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent" />
      </section>

      <div className="container mx-auto px-4 py-16 max-w-6xl">
        {/* Whitepaper Roadmap */}
        <section className="mb-20">
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">
              <span className="gradient-text">{t('whitepaper.title')}</span>
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="space-y-6">
            <PhaseCard
              version={t('whitepaper.v0_1.version')}
              title={t('whitepaper.v0_1.title')}
              status="completed"
              statusLabel={t('whitepaper.v0_1.status')}
              items={t.raw('whitepaper.v0_1.items') as string[]}
            />
            <PhaseCard
              version={t('whitepaper.v0_2.version')}
              title={t('whitepaper.v0_2.title')}
              status="in-progress"
              statusLabel={t('whitepaper.v0_2.status')}
              items={t.raw('whitepaper.v0_2.items') as string[]}
            />
            <PhaseCard
              version={t('whitepaper.v0_3.version')}
              title={t('whitepaper.v0_3.title')}
              status="planned"
              statusLabel={t('whitepaper.v0_3.status')}
              items={t.raw('whitepaper.v0_3.items') as string[]}
            />
            <PhaseCard
              version={t('whitepaper.v0_4.version')}
              title={t('whitepaper.v0_4.title')}
              status="planned"
              statusLabel={t('whitepaper.v0_4.status')}
              items={t.raw('whitepaper.v0_4.items') as string[]}
            />
          </div>
        </section>

        {/* Implementation Progress */}
        <section className="mb-20">
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">
              <span className="gradient-text">{t('implementation.title')}</span>
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="space-y-4">
            <CycleGroup
              title={t('implementation.infrastructure.title')}
              cycles={t.raw('implementation.infrastructure.cycles') as { num: number; desc: string }[]}
            />

            <CycleGroup
              title={t('implementation.consolidation.title')}
              cycles={t.raw('implementation.consolidation.cycles') as { num: number; desc: string }[]}
            />

            <CycleGroup
              title={t('implementation.features.title')}
              cycles={t.raw('implementation.features.cycles') as { num: number; desc: string }[]}
            />
          </div>
        </section>

        {/* Future Plans */}
        <section>
          <div className="text-center mb-12 fade-in-up">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-4">
              <span className="gradient-text">{t('future.title')}</span>
            </h2>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FuturePlanCard
              icon={t('future.aiAgent.icon')}
              title={t('future.aiAgent.title')}
              items={t.raw('future.aiAgent.items') as string[]}
            />
            <FuturePlanCard
              icon={t('future.crossChain.icon')}
              title={t('future.crossChain.title')}
              items={t.raw('future.crossChain.items') as string[]}
            />
            <FuturePlanCard
              icon={t('future.analytics.icon')}
              title={t('future.analytics.title')}
              items={t.raw('future.analytics.items') as string[]}
            />
            <FuturePlanCard
              icon={t('future.privacy.icon')}
              title={t('future.privacy.title')}
              items={t.raw('future.privacy.items') as string[]}
            />
            <FuturePlanCard
              icon={t('future.performance.icon')}
              title={t('future.performance.title')}
              items={t.raw('future.performance.items') as string[]}
            />
            <FuturePlanCard
              icon={t('future.ecosystem.icon')}
              title={t('future.ecosystem.title')}
              items={t.raw('future.ecosystem.items') as string[]}
            />
          </div>
        </section>

        {/* CTA */}
        <section className="mt-20 relative overflow-hidden rounded-xl">
          <div className="absolute inset-0 bg-gradient-to-br from-accent-cyan/10 via-accent-blue/10 to-accent-purple/10" />
          <div className="absolute inset-0 noise-texture" />

          <div className="relative z-10 p-12 text-center">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-4 fade-in-up">
              <span className="gradient-text">{t('cta.title')}</span>
            </h2>
            <p className="mb-8 text-text-secondary font-body text-lg fade-in-delay-1">{t('cta.subtitle')}</p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center fade-in-delay-2">
              <a
                href="https://github.com/openclaw/openclaw"
                className="group relative px-8 py-4 rounded-lg font-display font-semibold text-lg overflow-hidden transition-all hover:scale-105"
              >
                <div className="absolute inset-0 bg-gradient-cyber opacity-100 group-hover:opacity-90 transition-opacity" />
                <div className="absolute inset-0 bg-gradient-cyber blur-xl opacity-50 group-hover:opacity-75 transition-opacity" />
                <span className="relative text-white">&gt; {t('cta.github')}</span>
              </a>
              <a
                href="/docs"
                className="group px-8 py-4 rounded-lg font-display font-semibold text-lg border-2 border-accent-cyan/50 bg-accent-cyan/5 hover:bg-accent-cyan/10 hover:border-accent-cyan transition-all hover:shadow-glow-md backdrop-blur-sm"
              >
                <span className="text-accent-cyan group-hover:text-accent-cyan/90">
                  {t('cta.docs')} →
                </span>
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function PhaseCard({
  version,
  title,
  status,
  statusLabel,
  items,
}: {
  version: string
  title: string
  status: 'completed' | 'in-progress' | 'planned'
  statusLabel: string
  items: string[]
}) {
  const statusConfig = {
    completed: {
      bg: 'bg-accent-cyan/20',
      text: 'text-accent-cyan',
      border: 'border-accent-cyan/50',
      glow: 'shadow-glow-sm',
    },
    'in-progress': {
      bg: 'bg-accent-blue/20',
      text: 'text-accent-blue',
      border: 'border-accent-blue/50',
      glow: 'shadow-glow-sm',
    },
    planned: {
      bg: 'bg-text-muted/10',
      text: 'text-text-muted',
      border: 'border-text-muted/30',
      glow: '',
    },
  }

  const config = statusConfig[status]

  return (
    <div className="group relative bg-bg-elevated rounded-xl overflow-hidden border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up">
      {/* Header */}
      <div className="relative bg-gradient-cyber p-6 overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <div className="absolute inset-0 bg-gradient-to-br from-accent-cyan via-accent-blue to-accent-purple" />
        </div>
        <div className="relative z-10 flex justify-between items-center">
          <div>
            <span className="font-display text-sm text-white/80 tracking-wider">{version}</span>
            <h3 className="text-2xl font-display font-bold text-white mt-1">{title}</h3>
          </div>
          <span
            className={`${config.bg} ${config.text} ${config.border} ${config.glow} border-2 px-4 py-2 rounded-lg font-display font-semibold text-sm backdrop-blur-sm`}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        <ul className="space-y-3">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-3 text-text-secondary font-body">
              <span className="text-accent-cyan mt-1 font-display">▸</span>
              <span className="flex-1">{item}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Bottom Border Accent */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

function CycleGroup({ title, cycles }: { title: string; cycles: { num: number; desc: string }[] }) {
  return (
    <div className="group bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 noise-texture fade-in-up">
      <h3 className="text-xl font-display font-bold mb-6 text-text-primary group-hover:text-accent-cyan transition-colors">
        {title}
      </h3>
      <div className="space-y-3">
        {cycles.map((c) => (
          <div key={c.num} className="flex gap-4 items-start group/item">
            <span className="bg-gradient-cyber text-white rounded-lg px-3 py-1.5 font-display font-bold text-sm min-w-[5rem] text-center shadow-glow-sm">
              Cycle {c.num}
            </span>
            <span className="text-text-secondary font-body flex-1 group-hover/item:text-text-primary transition-colors">
              {c.desc}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function FuturePlanCard({ icon, title, items }: { icon: string; title: string; items: string[] }) {
  return (
    <div className="group relative bg-bg-elevated rounded-xl p-6 border border-text-muted/10 hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md noise-texture fade-in-up">
      {/* Hover Glow Effect */}
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />

      {/* Icon */}
      <div className="text-5xl mb-4 filter grayscale group-hover:grayscale-0 transition-all duration-500 float relative z-10">
        {icon}
      </div>

      {/* Content */}
      <h3 className="text-xl font-display font-bold mb-4 text-text-primary group-hover:text-accent-cyan transition-colors relative z-10">
        {title}
      </h3>
      <ul className="space-y-2 relative z-10">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-text-secondary font-body">
            <span className="text-accent-cyan font-display mt-1">▸</span>
            <span className="flex-1">{item}</span>
          </li>
        ))}
      </ul>

      {/* Bottom Border Accent */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
    </div>
  )
}

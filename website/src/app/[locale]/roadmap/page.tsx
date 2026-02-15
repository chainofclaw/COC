'use client'

import { useTranslations } from 'next-intl'

export default function RoadmapPage() {
  const t = useTranslations('roadmap')

  return (
    <div className="bg-gray-50 min-h-screen">
      {/* Header */}
      <section className="bg-gradient-to-r from-indigo-600 to-purple-700 text-white py-16">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('title')}</h1>
          <p className="text-xl text-indigo-100">{t('subtitle')}</p>
        </div>
      </section>

      <div className="container mx-auto px-4 py-12 max-w-5xl">
        {/* Whitepaper Roadmap */}
        <section className="mb-16">
          <h2 className="text-3xl font-bold mb-8 text-gray-900">{t('whitepaper.title')}</h2>
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
        <section className="mb-16">
          <h2 className="text-3xl font-bold mb-8 text-gray-900">{t('implementation.title')}</h2>
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
          <h2 className="text-3xl font-bold mb-8 text-gray-900">{t('future.title')}</h2>
          <div className="grid md:grid-cols-2 gap-6">
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
        <section className="mt-16 bg-gradient-to-r from-blue-600 to-indigo-700 text-white rounded-xl p-8 text-center">
          <h2 className="text-2xl font-bold mb-4">{t('cta.title')}</h2>
          <p className="mb-6 text-blue-100">{t('cta.subtitle')}</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a
              href="https://github.com/openclaw/openclaw"
              className="bg-white text-blue-600 px-6 py-3 rounded-lg font-semibold hover:bg-blue-50 transition"
            >
              {t('cta.github')}
            </a>
            <a
              href="/docs"
              className="bg-transparent border-2 border-white px-6 py-3 rounded-lg font-semibold hover:bg-white hover:bg-opacity-10 transition"
            >
              {t('cta.docs')}
            </a>
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
    completed: { bg: 'bg-green-100', text: 'text-green-800' },
    'in-progress': { bg: 'bg-blue-100', text: 'text-blue-800' },
    planned: { bg: 'bg-gray-100', text: 'text-gray-800' },
  }

  const config = statusConfig[status]

  return (
    <div className="bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden">
      <div className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4 flex justify-between items-center">
        <div>
          <span className="text-sm font-semibold opacity-90">{version}</span>
          <h3 className="text-xl font-bold">{title}</h3>
        </div>
        <span className={`${config.bg} ${config.text} px-3 py-1 rounded-full text-sm font-semibold`}>
          {statusLabel}
        </span>
      </div>
      <div className="p-6">
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-gray-700">
              <span className="text-indigo-600 mt-1">•</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function CycleGroup({ title, cycles }: { title: string; cycles: { num: number; desc: string }[] }) {
  return (
    <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
      <h3 className="text-xl font-bold mb-4 text-gray-900">{title}</h3>
      <div className="space-y-2">
        {cycles.map((c) => (
          <div key={c.num} className="flex gap-3 items-start">
            <span className="bg-blue-600 text-white rounded px-2 py-1 text-xs font-bold min-w-[4rem] text-center">
              Cycle {c.num}
            </span>
            <span className="text-gray-700 flex-1">{c.desc}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function FuturePlanCard({ icon, title, items }: { icon: string; title: string; items: string[] }) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200 hover:shadow-xl transition">
      <div className="text-4xl mb-3">{icon}</div>
      <h3 className="text-xl font-bold mb-4 text-gray-900">{title}</h3>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-gray-600">
            <span className="text-purple-600">▸</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

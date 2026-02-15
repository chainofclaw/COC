'use client'

import { useTranslations } from 'next-intl'

export default function TechnologyPage() {
  const t = useTranslations('technology')

  return (
    <div className="bg-white">
      {/* Header */}
      <section className="bg-gradient-to-r from-purple-600 to-indigo-700 text-white py-16">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('title')}</h1>
          <p className="text-xl text-purple-100">{t('subtitle')}</p>
        </div>
      </section>

      <div className="container mx-auto px-4 py-12 max-w-5xl">
        {/* Architecture Layers */}
        <section className="mb-16">
          <h2 className="text-3xl font-bold mb-8 text-center text-gray-900">{t('layersTitle')}</h2>
          <div className="space-y-6">
            <LayerCard
              number={t('layer1.number')}
              title={t('layer1.title')}
              subtitle={t('layer1.subtitle')}
              color="blue"
              features={t.raw('layer1.features') as string[]}
              note={t('layer1.note')}
            />

            <LayerCard
              number={t('layer2.number')}
              title={t('layer2.title')}
              subtitle={t('layer2.subtitle')}
              color="indigo"
              features={t.raw('layer2.features') as string[]}
              note={t('layer2.note')}
            />

            <LayerCard
              number={t('layer3.number')}
              title={t('layer3.title')}
              subtitle={t('layer3.subtitle')}
              color="purple"
              features={t.raw('layer3.features') as string[]}
              note={t('layer3.note')}
            />

            <LayerCard
              number={t('layer4.number')}
              title={t('layer4.title')}
              subtitle={t('layer4.subtitle')}
              color="pink"
              features={t.raw('layer4.features') as string[]}
              note={t('layer4.note')}
            />
          </div>
        </section>

        {/* PoSe Protocol Deep Dive */}
        <section className="mb-16">
          <h2 className="text-3xl font-bold mb-8 text-gray-900">{t('poseProtocol.title')}</h2>

          <div className="space-y-8">
            {/* Challenge Flow */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-8 rounded-xl border border-blue-200">
              <h3 className="text-2xl font-semibold mb-6 text-gray-900">{t('poseProtocol.challengeFlow')}</h3>
              <div className="space-y-4">
                <FlowStep
                  step="1"
                  title={t('poseProtocol.step1.title')}
                  description={t('poseProtocol.step1.description')}
                  details={t.raw('poseProtocol.step1.details') as string[]}
                />
                <FlowStep
                  step="2"
                  title={t('poseProtocol.step2.title')}
                  description={t('poseProtocol.step2.description')}
                  details={t.raw('poseProtocol.step2.details') as string[]}
                />
                <FlowStep
                  step="3"
                  title={t('poseProtocol.step3.title')}
                  description={t('poseProtocol.step3.description')}
                  details={t.raw('poseProtocol.step3.details') as string[]}
                />
                <FlowStep
                  step="4"
                  title={t('poseProtocol.step4.title')}
                  description={t('poseProtocol.step4.description')}
                  details={t.raw('poseProtocol.step4.details') as string[]}
                />
                <FlowStep
                  step="5"
                  title={t('poseProtocol.step5.title')}
                  description={t('poseProtocol.step5.description')}
                  details={t.raw('poseProtocol.step5.details') as string[]}
                />
              </div>
            </div>

            {/* Scoring Formulas */}
            <div>
              <h3 className="text-2xl font-semibold mb-4 text-gray-900">{t('poseProtocol.scoringTitle')}</h3>
              <div className="grid md:grid-cols-2 gap-6">
                <FormulaCard
                  title={t('poseProtocol.uptimeScore.title')}
                  formula={t('poseProtocol.uptimeScore.formula')}
                  variables={t.raw('poseProtocol.uptimeScore.variables') as string[]}
                  rationale={t('poseProtocol.uptimeScore.rationale')}
                />
                <FormulaCard
                  title={t('poseProtocol.storageScore.title')}
                  formula={t('poseProtocol.storageScore.formula')}
                  variables={t.raw('poseProtocol.storageScore.variables') as string[]}
                  rationale={t('poseProtocol.storageScore.rationale')}
                />
              </div>
            </div>

            {/* Anti-Sybil */}
            <div className="bg-yellow-50 p-6 rounded-lg border border-yellow-200">
              <h3 className="text-xl font-semibold mb-4 text-gray-900">{t('poseProtocol.antiSybilTitle')}</h3>
              <div className="grid md:grid-cols-2 gap-4">
                <ul className="space-y-2 text-gray-700">
                  {(t.raw('poseProtocol.antiSybilItems') as string[]).slice(0, 4).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
                <ul className="space-y-2 text-gray-700">
                  {(t.raw('poseProtocol.antiSybilItems') as string[]).slice(4).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Performance Metrics */}
        <section className="mb-16">
          <h2 className="text-3xl font-bold mb-8 text-gray-900">{t('performance.title')}</h2>
          <div className="grid md:grid-cols-3 gap-6">
            <MetricCard
              title={t('performance.blockTime.title')}
              value={t('performance.blockTime.value')}
              description={t('performance.blockTime.description')}
            />
            <MetricCard
              title={t('performance.finality.title')}
              value={t('performance.finality.value')}
              description={t('performance.finality.description')}
            />
            <MetricCard
              title={t('performance.storage.title')}
              value={t('performance.storage.value')}
              description={t('performance.storage.description')}
            />
            <MetricCard
              title={t('performance.bandwidth.title')}
              value={t('performance.bandwidth.value')}
              description={t('performance.bandwidth.description')}
            />
            <MetricCard
              title={t('performance.frequency.title')}
              value={t('performance.frequency.value')}
              description={t('performance.frequency.description')}
            />
            <MetricCard
              title={t('performance.threshold.title')}
              value={t('performance.threshold.value')}
              description={t('performance.threshold.description')}
            />
          </div>
        </section>

        {/* Comparison */}
        <section className="mb-16">
          <h2 className="text-3xl font-bold mb-8 text-gray-900">{t('comparison.title')}</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full bg-white border border-gray-200 rounded-lg">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">{t('comparison.dimensions.barrier')}</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">PoW</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">PoS</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900 bg-blue-50">COC (PoSe)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                <ComparisonRow
                  dimension={t('comparison.dimensions.barrier')}
                  pow={t('comparison.pow.barrier')}
                  pos={t('comparison.pos.barrier')}
                  coc={t('comparison.coc.barrier')}
                  cocBetter
                />
                <ComparisonRow
                  dimension={t('comparison.dimensions.centralization')}
                  pow={t('comparison.pow.centralization')}
                  pos={t('comparison.pos.centralization')}
                  coc={t('comparison.coc.centralization')}
                  cocBetter
                />
                <ComparisonRow
                  dimension={t('comparison.dimensions.energy')}
                  pow={t('comparison.pow.energy')}
                  pos={t('comparison.pos.energy')}
                  coc={t('comparison.coc.energy')}
                />
                <ComparisonRow
                  dimension={t('comparison.dimensions.reward')}
                  pow={t('comparison.pow.reward')}
                  pos={t('comparison.pos.reward')}
                  coc={t('comparison.coc.reward')}
                  cocBetter
                />
                <ComparisonRow
                  dimension={t('comparison.dimensions.decentralization')}
                  pow={t('comparison.pow.decentralization')}
                  pos={t('comparison.pos.decentralization')}
                  coc={t('comparison.coc.decentralization')}
                  cocBetter
                />
                <ComparisonRow
                  dimension={t('comparison.dimensions.automation')}
                  pow={t('comparison.pow.automation')}
                  pos={t('comparison.pos.automation')}
                  coc={t('comparison.coc.automation')}
                  cocBetter
                />
              </tbody>
            </table>
          </div>
        </section>

        {/* Tech Stack */}
        <section>
          <h2 className="text-3xl font-bold mb-8 text-gray-900">{t('techStack.title')}</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <TechStackCard
              title={t('techStack.execution.title')}
              items={t.raw('techStack.execution.items') as string[]}
            />
            <TechStackCard
              title={t('techStack.consensus.title')}
              items={t.raw('techStack.consensus.items') as string[]}
            />
            <TechStackCard
              title={t('techStack.pose.title')}
              items={t.raw('techStack.pose.items') as string[]}
            />
            <TechStackCard
              title={t('techStack.storage.title')}
              items={t.raw('techStack.storage.items') as string[]}
            />
          </div>
        </section>
      </div>
    </div>
  )
}

function LayerCard({
  number,
  title,
  subtitle,
  color,
  features,
  note,
}: {
  number: string
  title: string
  subtitle: string
  color: string
  features: string[]
  note: string
}) {
  const colorMap: Record<string, string> = {
    blue: 'from-blue-500 to-blue-600',
    indigo: 'from-indigo-500 to-indigo-600',
    purple: 'from-purple-500 to-purple-600',
    pink: 'from-pink-500 to-pink-600',
  }

  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
      <div className={`bg-gradient-to-r ${colorMap[color]} text-white p-6`}>
        <div className="flex items-center gap-4 mb-2">
          <div className="bg-white bg-opacity-20 rounded-full w-12 h-12 flex items-center justify-center font-bold text-2xl">
            {number}
          </div>
          <div>
            <h3 className="text-2xl font-bold">{title}</h3>
            <p className="text-sm opacity-90">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="p-6">
        <ul className="space-y-2 mb-4">
          {features.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-gray-700">
              <span className="text-green-600 mt-1">✓</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <div className="bg-gray-50 p-3 rounded border-l-4 border-gray-400">
          <p className="text-sm text-gray-600 italic">{note}</p>
        </div>
      </div>
    </div>
  )
}

function FlowStep({
  step,
  title,
  description,
  details,
}: {
  step: string
  title: string
  description: string
  details: string[]
}) {
  return (
    <div className="flex gap-4">
      <div className="bg-blue-600 text-white rounded-full w-10 h-10 flex items-center justify-center font-bold flex-shrink-0">
        {step}
      </div>
      <div className="flex-1">
        <h4 className="font-bold text-gray-900 mb-1">{title}</h4>
        <p className="text-gray-700 mb-2">{description}</p>
        <ul className="space-y-1">
          {details.map((d, i) => (
            <li key={i} className="text-sm text-gray-600 font-mono bg-white p-2 rounded">
              {d}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function FormulaCard({
  title,
  formula,
  variables,
  rationale,
}: {
  title: string
  formula: string
  variables: string[]
  rationale: string
}) {
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow">
      <h4 className="font-bold text-gray-900 mb-3">{title}</h4>
      <div className="bg-blue-50 p-3 rounded mb-3 font-mono text-sm">{formula}</div>
      <div className="space-y-1 mb-3">
        {variables.map((v, i) => (
          <p key={i} className="text-sm text-gray-600">
            • {v}
          </p>
        ))}
      </div>
      <div className="bg-yellow-50 p-3 rounded border-l-4 border-yellow-400">
        <p className="text-sm text-gray-700 italic">{rationale}</p>
      </div>
    </div>
  )
}

function MetricCard({
  title,
  value,
  description,
}: {
  title: string
  value: string
  description: string
}) {
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow text-center">
      <h4 className="text-sm font-medium text-gray-500 uppercase mb-2">{title}</h4>
      <p className="text-3xl font-bold text-blue-600 mb-2">{value}</p>
      <p className="text-sm text-gray-600">{description}</p>
    </div>
  )
}

function ComparisonRow({
  dimension,
  pow,
  pos,
  coc,
  cocBetter = false,
}: {
  dimension: string
  pow: string
  pos: string
  coc: string
  cocBetter?: boolean
}) {
  return (
    <tr>
      <td className="px-6 py-4 font-semibold text-gray-900">{dimension}</td>
      <td className="px-6 py-4 text-gray-600">{pow}</td>
      <td className="px-6 py-4 text-gray-600">{pos}</td>
      <td className={`px-6 py-4 ${cocBetter ? 'bg-blue-50 font-semibold text-blue-900' : 'text-gray-600'}`}>
        {coc}
      </td>
    </tr>
  )
}

function TechStackCard({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow">
      <h3 className="text-lg font-bold mb-4 text-gray-900">{title}</h3>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-gray-700">
            <span className="text-blue-600">▸</span>
            <span className="font-mono text-sm">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

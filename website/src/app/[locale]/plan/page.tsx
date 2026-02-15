'use client'

import { useTranslations } from 'next-intl'

export default function PlanPage() {
  const t = useTranslations('about')

  return (
    <div className="bg-white">
      {/* Header */}
      <section className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white py-16">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('title')}</h1>
          <p className="text-xl text-blue-100">{t('subtitle')}</p>
        </div>
      </section>

      <div className="container mx-auto px-4 py-12 max-w-4xl">
        {/* Abstract */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-4 text-gray-900">{t('abstract.title')}</h2>
          <div className="bg-blue-50 border-l-4 border-blue-600 p-6 rounded">
            <p className="text-gray-800 leading-relaxed">
              {t('abstract.intro')}<br /><br />
              • <strong>{t('abstract.pow')}</strong><br />
              • <strong>{t('abstract.pos')}</strong><br /><br />
              {t('abstract.pose')}
            </p>
          </div>
        </section>

        {/* Vision & Goals */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('vision.title')}</h2>

          <div className="mb-6">
            <h3 className="text-2xl font-semibold mb-3 text-gray-800">{t('vision.mission')}</h3>
            <div className="bg-gray-50 p-6 rounded-lg">
              <p className="text-lg text-gray-700 italic">
                "{t('vision.missionText')}"
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-2xl font-semibold mb-4 text-gray-800">{t('vision.goals')}</h3>
            <div className="grid md:grid-cols-2 gap-4">
              <GoalCard
                number="1"
                title={t('vision.goal1.title')}
                description={t('vision.goal1.desc')}
              />
              <GoalCard
                number="2"
                title={t('vision.goal2.title')}
                description={t('vision.goal2.desc')}
              />
              <GoalCard
                number="3"
                title={t('vision.goal3.title')}
                description={t('vision.goal3.desc')}
              />
              <GoalCard
                number="4"
                title={t('vision.goal4.title')}
                description={t('vision.goal4.desc')}
              />
              <GoalCard
                number="5"
                title={t('vision.goal5.title')}
                description={t('vision.goal5.desc')}
              />
              <GoalCard
                number="6"
                title={t('vision.goal6.title')}
                description={t('vision.goal6.desc')}
              />
            </div>
          </div>
        </section>

        {/* Economic Model */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('economic.title')}</h2>

          <div className="space-y-6">
            <div className="bg-gradient-to-r from-green-50 to-emerald-50 p-6 rounded-lg border border-green-200">
              <h3 className="text-xl font-semibold mb-3 text-gray-900">{t('economic.rewardPool')}</h3>
              <div className="text-lg font-mono text-gray-800">
                R<sub>epoch</sub> = R<sub>fees</sub> + R<sub>inflation</sub>
              </div>
              <p className="mt-2 text-gray-700">
                • R<sub>fees</sub>: 收集的交易费用<br />
                • R<sub>inflation</sub>: 引导性通胀补贴(随时间衰减)
              </p>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-3 text-gray-900">{t('economic.epochLength')}</h3>
              <div className="bg-blue-50 p-4 rounded border border-blue-200">
                <p className="text-gray-800">
                  <strong>{t('economic.epochDefault')}</strong><br />
                  {t('economic.blockTime')}
                </p>
              </div>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-3 text-gray-900">{t('economic.buckets')}</h3>
              <div className="grid md:grid-cols-3 gap-4">
                <BucketCard title={t('economic.bucket1')} percentage="60%" color="blue" />
                <BucketCard title={t('economic.bucket2')} percentage="30%" color="purple" />
                <BucketCard title={t('economic.bucket3')} percentage="10%" color="pink" />
              </div>
              <p className="mt-4 text-gray-600">
                <strong>{t('economic.rationale')}</strong>
              </p>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-3 text-gray-900">{t('economic.bond')}</h3>
              <div className="bg-yellow-50 p-6 rounded-lg border border-yellow-200">
                <p className="text-gray-800 mb-2">
                  {t('economic.bondIntro')}
                </p>
                <ul className="list-disc list-inside space-y-1 text-gray-700">
                  <li>{t('economic.bondTarget')}</li>
                  <li>{t('economic.bondUnlock')}</li>
                  <li>{t('economic.bondPurpose')}</li>
                  <li>{t('economic.bondNoPower')}</li>
                  <li>{t('economic.bondNoReward')}</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* PoSe Protocol */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('pose.title')}</h2>

          <div className="mb-6">
            <h3 className="text-2xl font-semibold mb-3 text-gray-800">{t('pose.coreIdea')}</h3>
            <p className="text-gray-700 leading-relaxed">
              {t('pose.coreText')}
            </p>
          </div>

          <div className="mb-6">
            <h3 className="text-2xl font-semibold mb-4 text-gray-800">{t('pose.types')}</h3>
            <div className="space-y-3">
              <ChallengeTypeCard
                type="U"
                name={t('pose.typeU')}
                detail="低成本,2.5秒超时"
              />
              <ChallengeTypeCard
                type="S"
                name={t('pose.typeS')}
                detail="中等成本,6秒超时"
              />
              <ChallengeTypeCard
                type="R"
                name={t('pose.typeR')}
                detail="谨慎使用;最低权重"
              />
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-2xl font-semibold mb-4 text-gray-800">{t('pose.frequency')}</h3>
            <div className="bg-gray-50 p-6 rounded-lg">
              <ul className="space-y-2 text-gray-700">
                <li>• {t('pose.freqU')}</li>
                <li>• {t('pose.freqS')}</li>
                <li>• {t('pose.freqR')}</li>
              </ul>
              <div className="mt-4 pt-4 border-t border-gray-300">
                <p className="font-semibold text-gray-800">{t('pose.threshold')}</p>
                <p className="text-gray-700">
                  • {t('pose.thresholdU')}<br />
                  • {t('pose.thresholdS')}
                </p>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-2xl font-semibold mb-3 text-gray-800">{t('pose.scoring')}</h3>
            <div className="bg-blue-50 p-6 rounded-lg border border-blue-200 space-y-4">
              <div>
                <p className="font-semibold text-gray-900 mb-2">正常运行时间/RPC分数:</p>
                <div className="font-mono text-sm text-gray-800 bg-white p-3 rounded">
                  S<sub>u,i</sub> = u<sub>i</sub> × (0.85 + 0.15 × lat<sub>i</sub>)
                </div>
                <p className="text-sm text-gray-600 mt-2">
                  其中 u<sub>i</sub> = 通过率, lat<sub>i</sub> = 延迟因子 (防止带宽军备竞赛)
                </p>
              </div>

              <div>
                <p className="font-semibold text-gray-900 mb-2">存储分数 (SN):</p>
                <div className="font-mono text-sm text-gray-800 bg-white p-3 rounded">
                  S<sub>s,i</sub> = s<sub>i</sub> × cap<sub>i</sub>
                </div>
                <p className="text-sm text-gray-600 mt-2">
                  cap<sub>i</sub> = √(min(storedGB, 500GB) / 500GB) — 收益递减
                </p>
              </div>

              <div>
                <p className="font-semibold text-gray-900 mb-2">中继分数 (RN):</p>
                <div className="font-mono text-sm text-gray-800 bg-white p-3 rounded">
                  S<sub>r,i</sub> = pass<sub>r,i</sub> / total<sub>r,i</sub>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Anti-Cheat */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('antiCheat.title')}</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <ThreatCard
              title={t('antiCheat.sybil')}
              mitigation={t.raw('antiCheat.sybilMit') as string[]}
            />
            <ThreatCard
              title={t('antiCheat.forgery')}
              mitigation={t.raw('antiCheat.forgeryMit') as string[]}
            />
            <ThreatCard
              title={t('antiCheat.collusion')}
              mitigation={t.raw('antiCheat.collusionMit') as string[]}
            />
            <ThreatCard
              title={t('antiCheat.network')}
              mitigation={t.raw('antiCheat.networkMit') as string[]}
            />
          </div>
        </section>

        {/* AI Agent */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('agent.title')}</h2>

          <div className="grid md:grid-cols-2 gap-6 mb-6">
            <div className="bg-green-50 p-6 rounded-lg border border-green-200">
              <h3 className="text-xl font-semibold mb-3 text-green-900">✅ {t('agent.canDo')}</h3>
              <ul className="space-y-2 text-gray-700">
                <li>✓ {t('agent.can1')}</li>
                <li>✓ {t('agent.can2')}</li>
                <li>✓ {t('agent.can3')}</li>
                <li>✓ {t('agent.can4')}</li>
                <li>✓ {t('agent.can5')}</li>
              </ul>
            </div>

            <div className="bg-red-50 p-6 rounded-lg border border-red-200">
              <h3 className="text-xl font-semibold mb-3 text-red-900">❌ {t('agent.cantDo')}</h3>
              <ul className="space-y-2 text-gray-700">
                <li>✗ {t('agent.cant1')}</li>
                <li>✗ {t('agent.cant2')}</li>
                <li>✗ {t('agent.cant3')}</li>
              </ul>
            </div>
          </div>

          <div className="bg-blue-50 p-6 rounded-lg border border-blue-200">
            <p className="text-gray-800 font-semibold">
              ⚡ {t('agent.note')}
            </p>
          </div>
        </section>

        {/* Roadmap Link */}
        <section className="text-center py-8">
          <h2 className="text-2xl font-bold mb-4 text-gray-900">{t('cta.title')}</h2>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a
              href="/technology"
              className="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition"
            >
              {t('cta.technology')}
            </a>
            <a
              href="/roadmap"
              className="bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold hover:bg-gray-700 transition"
            >
              {t('cta.roadmap')}
            </a>
            <a
              href="/docs"
              className="border-2 border-blue-600 text-blue-600 px-6 py-3 rounded-lg font-semibold hover:bg-blue-50 transition"
            >
              {t('cta.docs')}
            </a>
          </div>
        </section>
      </div>
    </div>
  )
}

function GoalCard({ number, title, description }: { number: string; title: string; description: string }) {
  return (
    <div className="bg-white p-4 rounded-lg border-l-4 border-blue-600 shadow">
      <div className="flex items-start gap-3">
        <div className="bg-blue-600 text-white rounded-full w-8 h-8 flex items-center justify-center font-bold flex-shrink-0">
          {number}
        </div>
        <div>
          <h4 className="font-semibold text-gray-900">{title}</h4>
          <p className="text-sm text-gray-600 mt-1">{description}</p>
        </div>
      </div>
    </div>
  )
}

function BucketCard({ title, percentage, color }: { title: string; percentage: string; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'from-blue-500 to-blue-600',
    purple: 'from-purple-500 to-purple-600',
    pink: 'from-pink-500 to-pink-600',
  }

  return (
    <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
      <div className={`bg-gradient-to-r ${colorMap[color]} text-white text-2xl font-bold py-3 rounded mb-3 text-center`}>
        {percentage}
      </div>
      <p className="text-center text-gray-800 font-semibold">{title}</p>
    </div>
  )
}

function ChallengeTypeCard({ type, name, detail }: { type: string; name: string; detail: string }) {
  return (
    <div className="flex items-center gap-4 bg-white p-4 rounded-lg shadow border border-gray-200">
      <div className="bg-indigo-600 text-white rounded font-bold w-10 h-10 flex items-center justify-center flex-shrink-0">
        {type}
      </div>
      <div>
        <h4 className="font-semibold text-gray-900">{name}</h4>
        <p className="text-sm text-gray-600">{detail}</p>
      </div>
    </div>
  )
}

function ThreatCard({ title, mitigation, mitigationLabel }: { title: string; mitigation: string[]; mitigationLabel?: string }) {
  return (
    <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
      <h3 className="text-lg font-bold mb-3 text-red-700">🔒 {title}</h3>
      <p className="text-sm font-semibold text-gray-700 mb-2">{mitigationLabel || '缓解措施:' }</p>
      <ul className="space-y-1">
        {mitigation.map((item, idx) => (
          <li key={idx} className="text-sm text-gray-600 flex items-start gap-2">
            <span className="text-green-600">✓</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

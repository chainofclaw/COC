'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'

export default function DocsPage() {
  const t = useTranslations('docs')
  return (
    <div className="bg-gray-50 min-h-screen">
      {/* Header */}
      <section className="bg-gradient-to-r from-green-600 to-teal-700 text-white py-16">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('title')}</h1>
          <p className="text-xl text-green-100">{t('subtitle')}</p>
        </div>
      </section>

      <div className="container mx-auto px-4 py-12 max-w-6xl">
        {/* Quick Start */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('quickStart.title')}</h2>
          <div className="grid md:grid-cols-3 gap-6">
            <QuickStartCard
              icon={t('quickStart.runNode.icon')}
              title={t('quickStart.runNode.title')}
              description={t('quickStart.runNode.description')}
              code={t('quickStart.runNode.code')}
            />
            <QuickStartCard
              icon={t('quickStart.deployContract.icon')}
              title={t('quickStart.deployContract.title')}
              description={t('quickStart.deployContract.description')}
              code={t('quickStart.deployContract.code')}
            />
            <QuickStartCard
              icon={t('quickStart.launchExplorer.icon')}
              title={t('quickStart.launchExplorer.title')}
              description={t('quickStart.launchExplorer.description')}
              code={t('quickStart.launchExplorer.code')}
            />
          </div>
        </section>

        {/* Core Documentation */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('coreDocs.title')}</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <DocCard
              title={t('coreDocs.whitepaper.title')}
              description={t('coreDocs.whitepaper.description')}
              links={[
                { label: t('coreDocs.whitepaper.link'), href: '/plan' },
              ]}
            />
            <DocCard
              title={t('coreDocs.architecture.title')}
              description={t('coreDocs.architecture.description')}
              links={(t.raw('coreDocs.architecture.links') as string[]).map((label, i) => ({
                label,
                href: '#',
              }))}
            />
            <DocCard
              title={t('coreDocs.algorithms.title')}
              description={t('coreDocs.algorithms.description')}
              links={(t.raw('coreDocs.algorithms.links') as string[]).map((label, i) => ({
                label,
                href: '#',
              }))}
            />
            <DocCard
              title={t('coreDocs.antiSybil.title')}
              description={t('coreDocs.antiSybil.description')}
              links={(t.raw('coreDocs.antiSybil.links') as string[]).map((label, i) => ({
                label,
                href: '#',
              }))}
            />
          </div>
        </section>

        {/* Development Guides */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('devGuides.title')}</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <GuideCard
              icon={t('devGuides.nodeOps.icon')}
              title={t('devGuides.nodeOps.title')}
              items={t.raw('devGuides.nodeOps.items') as string[]}
            />
            <GuideCard
              icon={t('devGuides.contracts.icon')}
              title={t('devGuides.contracts.title')}
              items={t.raw('devGuides.contracts.items') as string[]}
            />
            <GuideCard
              icon={t('devGuides.rpcApi.icon')}
              title={t('devGuides.rpcApi.title')}
              items={t.raw('devGuides.rpcApi.items') as string[]}
            />
            <GuideCard
              icon={t('devGuides.aiAgent.icon')}
              title={t('devGuides.aiAgent.title')}
              items={t.raw('devGuides.aiAgent.items') as string[]}
            />
          </div>
        </section>

        {/* Implementation Status */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('implementationStatus.title')}</h2>
          <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200">
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
            <div className="text-center">
              <p className="text-sm text-gray-600 mb-4">
                {t('implementationStatus.detailsNote')}
              </p>
              <a
                href="https://github.com/openclaw/openclaw"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-gray-900 text-white px-6 py-3 rounded-lg font-semibold hover:bg-gray-800 transition"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
                {t('implementationStatus.viewGithub')}
              </a>
            </div>
          </div>
        </section>

        {/* Tools */}
        <section className="mb-12">
          <h2 className="text-3xl font-bold mb-6 text-gray-900">{t('tools.title')}</h2>
          <div className="grid md:grid-cols-3 gap-6">
            <ToolCard
              title={t('tools.wallet.title')}
              description={t('tools.wallet.description')}
              features={t.raw('tools.wallet.features') as string[]}
              openToolText={t('tools.openTool')}
            />
            <ToolCard
              title={t('tools.explorer.title')}
              description={t('tools.explorer.description')}
              features={t.raw('tools.explorer.features') as string[]}
              link="http://localhost:3000"
              openToolText={t('tools.openTool')}
            />
            <ToolCard
              title={t('tools.testing.title')}
              description={t('tools.testing.description')}
              features={t.raw('tools.testing.features') as string[]}
              openToolText={t('tools.openTool')}
            />
          </div>
        </section>

        {/* Resources */}
        <section>
          <div className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white rounded-xl p-8">
            <h2 className="text-2xl font-bold mb-6">{t('resources.title')}</h2>
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
}: {
  icon: string
  title: string
  description: string
  code: string
}) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200">
      <div className="text-4xl mb-3">{icon}</div>
      <h3 className="text-xl font-bold mb-2 text-gray-900">{title}</h3>
      <p className="text-gray-600 mb-4 text-sm">{description}</p>
      <pre className="bg-gray-900 text-green-400 p-3 rounded text-xs overflow-x-auto">
        {code}
      </pre>
    </div>
  )
}

function DocCard({
  title,
  description,
  links,
}: {
  title: string
  description: string
  links: { label: string; href: string }[]
}) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200 hover:shadow-xl transition">
      <h3 className="text-xl font-bold mb-3 text-gray-900">{title}</h3>
      <p className="text-gray-600 mb-4">{description}</p>
      <div className="space-y-2">
        {links.map((link, i) => (
          <a
            key={i}
            href={link.href}
            className="block text-blue-600 hover:text-blue-800 font-medium text-sm"
          >
            → {link.label}
          </a>
        ))}
      </div>
    </div>
  )
}

function GuideCard({ icon, title, items }: { icon: string; title: string; items: string[] }) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-3xl">{icon}</span>
        <h3 className="text-xl font-bold text-gray-900">{title}</h3>
      </div>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-gray-700">
            <span className="text-green-600">✓</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StatusItem({ label, status, details }: { label: string; status: string; details: string }) {
  const statusColors: Record<string, string> = {
    完成: 'bg-green-100 text-green-800',
    进行中: 'bg-blue-100 text-blue-800',
    良好: 'bg-emerald-100 text-emerald-800',
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-gray-900">{label}</span>
        <span className={`text-xs px-2 py-1 rounded ${statusColors[status] || 'bg-gray-100 text-gray-800'}`}>
          {status}
        </span>
      </div>
      <p className="text-sm text-gray-600">{details}</p>
    </div>
  )
}

function ToolCard({
  title,
  description,
  features,
  link,
  openToolText,
}: {
  title: string
  description: string
  features: string[]
  link?: string
  openToolText: string
}) {
  return (
    <div className="bg-white rounded-lg shadow-lg p-6 border border-gray-200">
      <h3 className="text-xl font-bold mb-2 text-gray-900">{title}</h3>
      <p className="text-gray-600 mb-4 text-sm">{description}</p>
      <ul className="space-y-1 mb-4">
        {features.map((f, i) => (
          <li key={i} className="text-sm text-gray-700 flex items-center gap-2">
            <span className="text-blue-600">▸</span>
            {f}
          </li>
        ))}
      </ul>
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 font-semibold text-sm"
        >
          {openToolText}
        </a>
      )}
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
      className="block bg-white bg-opacity-10 backdrop-blur p-4 rounded-lg hover:bg-opacity-20 transition"
    >
      <h3 className="font-bold mb-1">{title}</h3>
      <p className="text-sm text-blue-100">{description}</p>
    </Link>
  )
}

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'
import { NetworkStats } from '@/components/NetworkStats'

export default function HomePage() {
  const t = useTranslations('home')

  return (
    <div>
      {/* Hero Section */}
      <section className="bg-gradient-to-br from-blue-600 via-indigo-700 to-purple-800 text-white">
        <div className="container mx-auto px-4 py-20 md:py-32">
          <div className="max-w-4xl mx-auto text-center">
            <h1 className="text-4xl md:text-6xl font-bold mb-6 leading-tight whitespace-pre-line">
              {t('hero.title')}
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-blue-100">{t('hero.subtitle')}</p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/plan"
                className="bg-white text-blue-600 px-8 py-4 rounded-lg font-bold text-lg hover:bg-blue-50 transition shadow-lg"
              >
                {t('hero.learnMore')}
              </Link>
              <a
                href="http://localhost:3000"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-blue-500 bg-opacity-20 backdrop-blur border-2 border-white px-8 py-4 rounded-lg font-bold text-lg hover:bg-opacity-30 transition"
              >
                {t('hero.browseBlockchain')}
              </a>
              <Link
                href="/docs"
                className="bg-transparent border-2 border-white px-8 py-4 rounded-lg font-bold text-lg hover:bg-white hover:bg-opacity-10 transition"
              >
                {t('hero.readDocs')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Network Stats Section */}
      <section className="bg-white py-12 border-b">
        <div className="container mx-auto px-4">
          <h2 className="text-2xl font-bold text-center mb-8 text-gray-800">
            {t('networkStats.title')}
          </h2>
          <NetworkStats />
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 bg-gray-50">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-4 text-gray-900">
            {t('features.title')}
          </h2>
          <p className="text-center text-gray-600 mb-12 max-w-2xl mx-auto">{t('features.subtitle')}</p>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
            <FeatureCard icon="🎯" title={t('features.pose.title')} description={t('features.pose.description')} />
            <FeatureCard
              icon="🤖"
              title={t('features.aiAgent.title')}
              description={t('features.aiAgent.description')}
            />
            <FeatureCard
              icon="💻"
              title={t('features.hardware.title')}
              description={t('features.hardware.description')}
            />
            <FeatureCard
              icon="🔒"
              title={t('features.nonPos.title')}
              description={t('features.nonPos.description')}
            />
            <FeatureCard
              icon="⚡"
              title={t('features.evmCompatible.title')}
              description={t('features.evmCompatible.description')}
            />
            <FeatureCard
              icon="🌐"
              title={t('features.storage.title')}
              description={t('features.storage.description')}
            />
          </div>
        </div>
      </section>

      {/* Architecture Overview */}
      <section className="py-16 bg-white">
        <div className="container mx-auto px-4">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-3xl md:text-4xl font-bold text-center mb-12 text-gray-900">
              {t('architecture.title')}
            </h2>
            <div className="space-y-4">
              <ArchitectureLayer
                number="1"
                title={t('architecture.layer1.title')}
                description={t('architecture.layer1.description')}
                color="blue"
              />
              <ArchitectureLayer
                number="2"
                title={t('architecture.layer2.title')}
                description={t('architecture.layer2.description')}
                color="indigo"
              />
              <ArchitectureLayer
                number="3"
                title={t('architecture.layer3.title')}
                description={t('architecture.layer3.description')}
                color="purple"
              />
              <ArchitectureLayer
                number="4"
                title={t('architecture.layer4.title')}
                description={t('architecture.layer4.description')}
                color="pink"
              />
            </div>
            <div className="text-center mt-8">
              <Link href="/technology" className="text-blue-600 hover:text-blue-800 font-semibold inline-flex items-center">
                {t('architecture.learnMore')}
                <svg className="w-5 h-5 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Node Roles */}
      <section className="py-16 bg-gradient-to-br from-gray-50 to-blue-50">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12 text-gray-900">
            {t('nodeRoles.title')}
          </h2>
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            <NodeRoleCard
              icon="🖥️"
              title={t('nodeRoles.fullNode.title')}
              description={t('nodeRoles.fullNode.description')}
              reward={t('nodeRoles.fullNode.reward')}
            />
            <NodeRoleCard
              icon="💾"
              title={t('nodeRoles.storageNode.title')}
              description={t('nodeRoles.storageNode.description')}
              reward={t('nodeRoles.storageNode.reward')}
            />
            <NodeRoleCard
              icon="📡"
              title={t('nodeRoles.relayNode.title')}
              description={t('nodeRoles.relayNode.description')}
              reward={t('nodeRoles.relayNode.reward')}
            />
          </div>
          <p className="text-center mt-8 text-gray-600">{t('nodeRoles.note')}</p>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 bg-blue-600 text-white">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-6">{t('cta.title')}</h2>
          <p className="text-xl mb-8 text-blue-100 max-w-2xl mx-auto">{t('cta.subtitle')}</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/docs"
              className="bg-white text-blue-600 px-8 py-4 rounded-lg font-bold text-lg hover:bg-blue-50 transition"
            >
              {t('cta.startNode')}
            </Link>
            <Link
              href="/network"
              className="bg-transparent border-2 border-white px-8 py-4 rounded-lg font-bold text-lg hover:bg-white hover:bg-opacity-10 transition"
            >
              {t('cta.viewNetwork')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}

function FeatureCard({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition border border-gray-100">
      <div className="text-4xl mb-4">{icon}</div>
      <h3 className="text-xl font-bold mb-2 text-gray-900">{title}</h3>
      <p className="text-gray-600">{description}</p>
    </div>
  )
}

function ArchitectureLayer({
  number,
  title,
  description,
  color,
}: {
  number: string
  title: string
  description: string
  color: string
}) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-500',
    indigo: 'bg-indigo-500',
    purple: 'bg-purple-500',
    pink: 'bg-pink-500',
  }

  return (
    <div className="flex items-start gap-4 bg-white rounded-lg shadow p-6 border border-gray-200">
      <div
        className={`${colorMap[color]} text-white rounded-full w-10 h-10 flex items-center justify-center font-bold flex-shrink-0`}
      >
        {number}
      </div>
      <div>
        <h3 className="text-lg font-bold mb-1 text-gray-900">{title}</h3>
        <p className="text-gray-600">{description}</p>
      </div>
    </div>
  )
}

function NodeRoleCard({ icon, title, description, reward }: { icon: string; title: string; description: string; reward: string }) {
  return (
    <div className="bg-white rounded-xl shadow-lg p-6 text-center hover:shadow-xl transition border border-gray-200">
      <div className="text-5xl mb-4">{icon}</div>
      <h3 className="text-xl font-bold mb-2 text-gray-900">{title}</h3>
      <p className="text-gray-600 mb-4">{description}</p>
      <div className="bg-blue-50 text-blue-700 font-semibold py-2 px-4 rounded-lg inline-block">{reward}</div>
    </div>
  )
}

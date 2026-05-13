'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/routing'

export default function ServicesPage() {
  const t = useTranslations('services')

  return (
    <div className="relative">
      {/* Hero */}
      <section className="relative min-h-[60vh] flex items-center overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-bg-primary via-bg-secondary to-bg-primary">
          <div className="absolute inset-0 opacity-20">
            <div className="absolute top-20 left-20 w-96 h-96 bg-accent-cyan rounded-full blur-[120px] animate-pulse-slow" />
            <div className="absolute bottom-20 right-20 w-96 h-96 bg-accent-purple rounded-full blur-[120px] animate-pulse-slow delay-1000" />
          </div>
        </div>

        <div className="container mx-auto px-4 py-20 relative z-10">
          <div className="max-w-4xl mx-auto text-center">
            <div className="inline-block mb-6 fade-in">
              <div className="px-4 py-2 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 backdrop-blur-sm">
                <span className="font-display text-sm text-accent-cyan tracking-wider">
                  {t('heroBadge')}
                </span>
              </div>
            </div>

            <h1 className="text-5xl md:text-6xl font-display font-bold mb-6 fade-in-delay-1">
              <span className="gradient-text glow-text">{t('title')}</span>
            </h1>
            <p className="text-xl text-text-secondary font-body mb-4 fade-in-delay-2">
              {t('heroTagline')}
            </p>
            <p className="text-base text-text-muted font-body mb-8 fade-in-delay-2 max-w-2xl mx-auto">
              {t('subtitle')}
            </p>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent" />
      </section>

      <div className="container mx-auto px-4 py-16 max-w-6xl">
        {/* Service 1: DID */}
        <ServiceCard
          color="cyan"
          badge={t('did.badge')}
          title={t('did.title')}
          tagline={t('did.tagline')}
          features={[t('did.f1'), t('did.f2'), t('did.f3'), t('did.f4'), t('did.f5')]}
          installCmd={t('did.install')}
          npmUrl="https://www.npmjs.com/package/@chainofclaw/coc-soul"
          contracts={[
            { name: 'SoulRegistry', addr: '0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1' },
            { name: 'DIDRegistry', addr: '0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE' },
          ]}
          docsHref="/docs"
        />

        {/* Service 2: Memory */}
        <ServiceCard
          color="purple"
          badge={t('memory.badge')}
          title={t('memory.title')}
          tagline={t('memory.tagline')}
          features={[t('memory.f1'), t('memory.f2'), t('memory.f3'), t('memory.f4'), t('memory.f5')]}
          installCmd={t('memory.install')}
          npmUrl="https://www.npmjs.com/package/@chainofclaw/claw-mem"
          contracts={[
            { name: 'CidRegistry', addr: '0x68B1D87F95878fE05B998F19b66F4baba5De1aed' },
          ]}
          docsHref="/docs"
        />

        {/* Service 3: Node */}
        <ServiceCard
          color="blue"
          badge={t('node.badge')}
          title={t('node.title')}
          tagline={t('node.tagline')}
          features={[t('node.f1'), t('node.f2'), t('node.f3'), t('node.f4'), t('node.f5')]}
          installCmd={t('node.install')}
          npmUrl="https://www.npmjs.com/package/@chainofclaw/coc-node"
          contracts={[]}
          docsHref="/testnet"
        />

        {/* OpenClaw Marketplace listings */}
        <section className="mt-16 mb-8">
          <div className="text-center mb-10 fade-in-up">
            <div className="inline-block mb-4">
              <div className="px-4 py-1 rounded-full border border-accent-cyan/30 bg-accent-cyan/5">
                <span className="font-display text-xs text-accent-cyan tracking-wider">&gt; OPENCLAW_REGISTRY</span>
              </div>
            </div>
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
              <span className="gradient-text">{t('openclawTitle')}</span>
            </h2>
            <p className="text-text-secondary font-body max-w-2xl mx-auto">
              {t('openclawSubtitle')}
            </p>
            <div className="w-24 h-1 bg-gradient-cyber mx-auto mt-4 rounded-full" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <OpenclawCard
              title="Memory system for claws"
              skillId="//claw-mem"
              version="v2.3.1"
              description="Give an AI agent persistent semantic memory that survives restarts and compaction. Captures structured observations from tool calls, summarizes sessions (LLM)…"
              overall="review"
              scans={{ vt: 'suspicious', llm: 'suspicious', static: 'suspicious' }}
              stats={{ downloads: 289, stars: 0, versions: 11, updated: 'May 11' }}
              color="purple"
            />
            <OpenclawCard
              title="Node of COC testnet"
              skillId="//coc-node"
              version="v1.2.0"
              description="Operate COC (ChainOfClaw) blockchain nodes — install, start, stop, monitor, and remove validator, fullnode, archive, gateway, and dev nodes. Use when the user…"
              overall="pass"
              scans={{ vt: 'pass', llm: 'pass', static: 'pass' }}
              stats={{ downloads: 243, stars: 0, versions: 6, updated: 'May 11' }}
              color="blue"
            />
            <OpenclawCard
              title="COC Soul Immortality"
              skillId="//coc-soul"
              version="v1.2.10"
              description="Give an AI agent a persistent on-chain soul on COC — register and manage the agent's decentralized identity (DID), anchor encrypted backups to IPFS + SoulReg…"
              overall="review"
              scans={{ vt: 'suspicious', llm: 'suspicious', static: 'pass' }}
              stats={{ downloads: 323, stars: 1, versions: 13, updated: 'May 11' }}
              color="cyan"
            />
          </div>
        </section>

        {/* Silicon Immortality narrative */}
        <section className="mt-20 mb-8">
          <div className="bg-gradient-to-br from-accent-cyan/10 via-accent-purple/10 to-accent-blue/10 backdrop-blur-lg rounded-2xl border border-accent-cyan/20 p-8 md:p-12">
            <div className="max-w-3xl mx-auto text-center">
              <h2 className="text-3xl md:text-4xl font-display font-bold mb-6">
                <span className="gradient-text">{t('immortalityTitle')}</span>
              </h2>
              <p className="text-text-secondary font-body leading-relaxed">
                {t('immortalityNarrative')}
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-4">
                <Link
                  href="/testnet"
                  className="px-6 py-2 rounded-lg bg-gradient-cyber text-white font-display font-semibold hover:shadow-glow-md transition-all hover:scale-105 text-sm"
                >
                  R3.2 Testnet
                </Link>
                <a
                  href="https://github.com/chainofclaw/COC"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-6 py-2 rounded-lg border border-accent-cyan/30 text-accent-cyan font-display font-semibold hover:bg-accent-cyan/10 transition-all text-sm"
                >
                  GitHub
                </a>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

// ----- Components -----

function ServiceCard({
  color,
  badge,
  title,
  tagline,
  features,
  installCmd,
  npmUrl,
  contracts,
  docsHref,
}: {
  color: 'cyan' | 'purple' | 'blue'
  badge: string
  title: string
  tagline: string
  features: string[]
  installCmd: string
  npmUrl: string
  contracts: Array<{ name: string; addr: string }>
  docsHref: string
}) {
  const t = useTranslations('services')
  const colorMap: Record<string, { border: string; bg: string; text: string; gradient: string }> = {
    cyan: {
      border: 'border-accent-cyan/30',
      bg: 'from-accent-cyan/10 to-accent-cyan/5',
      text: 'text-accent-cyan',
      gradient: 'bg-gradient-cyber',
    },
    purple: {
      border: 'border-accent-purple/30',
      bg: 'from-accent-purple/10 to-accent-purple/5',
      text: 'text-accent-purple',
      gradient: 'bg-gradient-to-r from-accent-purple to-accent-blue',
    },
    blue: {
      border: 'border-accent-blue/30',
      bg: 'from-accent-blue/10 to-accent-blue/5',
      text: 'text-accent-blue',
      gradient: 'bg-gradient-to-r from-accent-blue to-accent-cyan',
    },
  }
  const c = colorMap[color]

  return (
    <section className={`mb-12 rounded-2xl border ${c.border} bg-gradient-to-br ${c.bg} backdrop-blur-lg p-6 md:p-10`}>
      <div className={`inline-block text-xs font-mono ${c.text} mb-4 px-3 py-1 rounded-full border ${c.border}`}>
        {badge}
      </div>
      <h2 className="text-3xl md:text-4xl font-display font-bold mb-2">
        <span className={c.text}>{title}</span>
      </h2>
      <p className="text-lg text-text-secondary font-body mb-8 italic">&ldquo;{tagline}&rdquo;</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Features */}
        <div>
          <h3 className="text-sm font-display uppercase tracking-wider text-text-muted mb-4">Features</h3>
          <ul className="space-y-2 font-body text-text-secondary text-sm">
            {features.map((f, i) => (
              <li key={i} className="flex gap-2">
                <span className={`${c.text} mt-0.5`}>▸</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Install + Contracts + Links */}
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-display uppercase tracking-wider text-text-muted mb-2">Install</h3>
            <div className="bg-bg-primary/60 rounded-lg p-3 font-mono text-sm text-text-primary border border-text-muted/10">
              <span className="text-text-muted">{t('installPrompt')} </span>
              <span>{installCmd}</span>
            </div>
          </div>

          {contracts.length > 0 && (
            <div>
              <h3 className="text-sm font-display uppercase tracking-wider text-text-muted mb-2">
                {t('linkedContracts')}
              </h3>
              <div className="space-y-1.5">
                {contracts.map((ct) => (
                  <a
                    key={ct.addr}
                    href={`https://explorer.clawchain.io/address/${ct.addr}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block bg-bg-primary/40 rounded p-2 hover:bg-bg-primary/60 transition-colors group"
                  >
                    <div className="text-xs font-display text-text-primary group-hover:text-accent-cyan transition-colors">
                      {ct.name}
                    </div>
                    <div className="text-xs font-mono text-text-muted break-all">{ct.addr}</div>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <a
              href={npmUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`px-4 py-2 rounded-lg ${c.gradient} text-white font-display font-semibold text-sm hover:scale-105 transition-all`}
            >
              {t('viewOnNpm')}
            </a>
            <Link
              href={docsHref}
              className={`px-4 py-2 rounded-lg border ${c.border} ${c.text} font-display font-semibold text-sm hover:bg-bg-primary/40 transition-all`}
            >
              {t('viewDocs')}
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}

type ScanStatus = 'pass' | 'review' | 'suspicious'

function OpenclawCard({
  title,
  skillId,
  version,
  description,
  overall,
  scans,
  stats,
  color,
}: {
  title: string
  skillId: string
  version: string
  description: string
  overall: ScanStatus
  scans: { vt: ScanStatus; llm: ScanStatus; static: ScanStatus }
  stats: { downloads: number; stars: number; versions: number; updated: string }
  color: 'cyan' | 'purple' | 'blue'
}) {
  const t = useTranslations('services')

  const borderMap: Record<string, string> = {
    cyan: 'border-accent-cyan/30 hover:border-accent-cyan/60',
    purple: 'border-accent-purple/30 hover:border-accent-purple/60',
    blue: 'border-accent-blue/30 hover:border-accent-blue/60',
  }
  const accentMap: Record<string, string> = {
    cyan: 'text-accent-cyan',
    purple: 'text-accent-purple',
    blue: 'text-accent-blue',
  }

  const statusLabel: Record<ScanStatus, string> = {
    pass: t('statusPass'),
    review: t('statusReview'),
    suspicious: t('statusSuspicious'),
  }
  const statusClass: Record<ScanStatus, string> = {
    pass: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    review: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    suspicious: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
  }
  const scanDotClass: Record<ScanStatus, string> = {
    pass: 'bg-emerald-400',
    review: 'bg-amber-400',
    suspicious: 'bg-rose-400',
  }

  return (
    <div
      className={`bg-bg-secondary/40 backdrop-blur-lg rounded-xl border ${borderMap[color]} p-5 transition-all hover:scale-[1.02] flex flex-col h-full`}
    >
      <div className="flex items-start justify-between mb-3 gap-2">
        <h3 className="text-base font-display font-bold text-text-primary leading-snug">{title}</h3>
        <span className={`text-[10px] font-display uppercase tracking-wider px-2 py-0.5 rounded border whitespace-nowrap ${statusClass[overall]}`}>
          {statusLabel[overall]}
        </span>
      </div>

      <div className="text-[11px] text-text-muted font-display uppercase tracking-wider mb-1">Skill</div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className={`font-mono text-sm ${accentMap[color]}`}>{skillId}</span>
        <span className="text-xs font-mono text-text-muted">{version}</span>
      </div>

      <p className="text-xs text-text-secondary font-body leading-relaxed mb-4 line-clamp-3">{description}</p>

      <div className="mb-4">
        <div className="text-[11px] text-text-muted font-display uppercase tracking-wider mb-2">
          {t('scanResult')}
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs font-mono">
          {(['vt', 'llm', 'static'] as const).map((k) => (
            <div key={k} className="flex items-center gap-1.5 bg-bg-primary/40 rounded px-2 py-1">
              <span className={`w-1.5 h-1.5 rounded-full ${scanDotClass[scans[k]]}`} />
              <span className="text-text-muted uppercase">{k}</span>
              <span className={`ml-auto text-[10px] ${
                scans[k] === 'pass' ? 'text-emerald-400'
                  : scans[k] === 'review' ? 'text-amber-400'
                  : 'text-rose-400'
              }`}>
                {statusLabel[scans[k]]}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center text-xs font-mono mt-auto pt-3 border-t border-text-muted/10">
        <StatCell label={t('downloads')} value={stats.downloads.toLocaleString()} />
        <StatCell label={t('stars')} value={String(stats.stars)} />
        <StatCell label={t('versions')} value={String(stats.versions)} />
        <StatCell label={t('updated')} value={stats.updated} />
      </div>
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-text-primary font-display font-bold text-sm">{value}</div>
      <div className="text-[10px] text-text-muted uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  )
}

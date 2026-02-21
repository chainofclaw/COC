'use client'

import { useTranslations } from 'next-intl'

export default function PlanPage() {
  const t = useTranslations('about')

  return (
    <div className="relative">
      {/* Hero Section */}
      <section className="relative min-h-[60vh] flex items-center overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-bg-primary via-bg-secondary to-bg-primary">
          <div className="absolute inset-0 opacity-20">
            <div className="absolute top-10 right-20 w-96 h-96 bg-accent-cyan rounded-full blur-[120px] animate-pulse-slow" />
            <div className="absolute bottom-20 left-20 w-96 h-96 bg-accent-purple rounded-full blur-[120px] animate-pulse-slow delay-1000" />
          </div>
        </div>

        <div className="container mx-auto px-4 py-20 relative z-10">
          <div className="max-w-5xl mx-auto text-center">
            <div className="inline-block mb-6 fade-in">
              <div className="px-4 py-2 rounded-full border border-accent-cyan/30 bg-accent-cyan/5 backdrop-blur-sm">
                <span className="font-display text-sm text-accent-cyan tracking-wider">
                  &gt; PROTOCOL_WHITEPAPER
                </span>
              </div>
            </div>

            <h1 className="text-5xl md:text-6xl font-display font-bold mb-6 fade-in-delay-1">
              <span className="gradient-text glow-text">{t('title')}</span>
            </h1>
            <p className="text-xl text-text-secondary max-w-3xl mx-auto font-body fade-in-delay-2">
              {t('subtitle')}
            </p>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-accent-cyan to-transparent" />
      </section>

      <div className="container mx-auto px-4 py-16 max-w-5xl">
        {/* Abstract */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('abstract.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-8 rounded-full" />

          <div className="bg-bg-elevated border-l-4 border-accent-cyan p-8 rounded-xl noise-texture relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-accent-cyan/5 to-transparent" />
            <div className="relative">
              <p className="text-text-secondary font-body leading-relaxed text-lg">
                {t('abstract.intro')}<br /><br />
                • <strong className="text-accent-cyan">{t('abstract.pow')}</strong><br />
                • <strong className="text-accent-blue">{t('abstract.pos')}</strong><br /><br />
                <span className="text-text-primary">{t('abstract.pose')}</span>
              </p>
            </div>
          </div>
        </section>

        {/* Vision & Goals */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('vision.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-12 rounded-full" />

          <div className="mb-12">
            <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary text-center">
              {t('vision.mission')}
            </h3>
            <div className="bg-bg-elevated p-8 rounded-xl border border-accent-cyan/30 noise-texture relative overflow-hidden hover:border-accent-cyan/50 transition-all duration-500">
              <div className="absolute inset-0 bg-gradient-cyber opacity-5" />
              <p className="text-xl text-text-secondary font-body italic text-center relative leading-relaxed">
                "{t('vision.missionText')}"
              </p>
            </div>
          </div>

          <div>
            <h3 className="text-2xl font-display font-semibold mb-8 text-text-primary text-center">
              {t('vision.goals')}
            </h3>
            <div className="grid md:grid-cols-2 gap-6">
              <GoalCard
                number="1"
                title={t('vision.goal1.title')}
                description={t('vision.goal1.desc')}
                delay="0"
              />
              <GoalCard
                number="2"
                title={t('vision.goal2.title')}
                description={t('vision.goal2.desc')}
                delay="0.1"
              />
              <GoalCard
                number="3"
                title={t('vision.goal3.title')}
                description={t('vision.goal3.desc')}
                delay="0.2"
              />
              <GoalCard
                number="4"
                title={t('vision.goal4.title')}
                description={t('vision.goal4.desc')}
                delay="0.3"
              />
              <GoalCard
                number="5"
                title={t('vision.goal5.title')}
                description={t('vision.goal5.desc')}
                delay="0.4"
              />
              <GoalCard
                number="6"
                title={t('vision.goal6.title')}
                description={t('vision.goal6.desc')}
                delay="0.5"
              />
            </div>
          </div>
        </section>

        {/* Economic Model */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('economic.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-12 rounded-full" />

          <div className="space-y-8">
            <div className="bg-bg-elevated p-8 rounded-xl border border-accent-cyan/30 noise-texture relative overflow-hidden hover:border-accent-cyan/50 transition-all duration-500 slide-in-right">
              <div className="absolute inset-0 bg-gradient-to-r from-accent-cyan/5 to-transparent" />
              <h3 className="text-xl font-display font-semibold mb-4 text-text-primary relative">
                {t('economic.rewardPool')}
              </h3>
              <div className="text-lg font-display text-accent-cyan mb-4 relative bg-bg-primary/50 p-4 rounded-lg border border-accent-cyan/20">
                R<sub>epoch</sub> = R<sub>fees</sub> + R<sub>inflation</sub>
              </div>
              <div className="text-text-secondary font-body relative space-y-2">
                <p>• R<sub>fees</sub>: 收集的交易费用</p>
                <p>• R<sub>inflation</sub>: 引导性通胀补贴(随时间衰减)</p>
              </div>
            </div>

            <div className="slide-in-right" style={{ animationDelay: '0.1s' }}>
              <h3 className="text-xl font-display font-semibold mb-4 text-text-primary">
                {t('economic.epochLength')}
              </h3>
              <div className="bg-bg-elevated p-6 rounded-xl border border-accent-blue/30 noise-texture hover:border-accent-blue/50 transition-all duration-500">
                <p className="text-text-secondary font-body">
                  <strong className="text-accent-blue">{t('economic.epochDefault')}</strong><br />
                  {t('economic.blockTime')}
                </p>
              </div>
            </div>

            <div className="slide-in-right" style={{ animationDelay: '0.2s' }}>
              <h3 className="text-xl font-display font-semibold mb-6 text-text-primary">
                {t('economic.buckets')}
              </h3>
              <div className="grid md:grid-cols-3 gap-6 mb-6">
                <BucketCard title={t('economic.bucket1')} percentage="60%" color="cyan" />
                <BucketCard title={t('economic.bucket2')} percentage="30%" color="blue" />
                <BucketCard title={t('economic.bucket3')} percentage="10%" color="purple" />
              </div>
              <p className="text-text-muted font-body text-center">
                <strong>{t('economic.rationale')}</strong>
              </p>
            </div>

            <div className="slide-in-right" style={{ animationDelay: '0.3s' }}>
              <h3 className="text-xl font-display font-semibold mb-4 text-text-primary">
                {t('economic.bond')}
              </h3>
              <div className="bg-bg-elevated p-8 rounded-xl border border-accent-purple/30 noise-texture hover:border-accent-purple/50 transition-all duration-500">
                <p className="text-text-secondary font-body mb-4">
                  {t('economic.bondIntro')}
                </p>
                <ul className="space-y-2 text-text-secondary font-body">
                  <li className="flex items-start gap-2">
                    <span className="text-accent-cyan mt-1">▸</span>
                    <span>{t('economic.bondTarget')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-accent-cyan mt-1">▸</span>
                    <span>{t('economic.bondUnlock')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-accent-cyan mt-1">▸</span>
                    <span>{t('economic.bondPurpose')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-accent-cyan mt-1">▸</span>
                    <span>{t('economic.bondNoPower')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-accent-cyan mt-1">▸</span>
                    <span>{t('economic.bondNoReward')}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* PoSe Protocol */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('pose.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-12 rounded-full" />

          <div className="mb-12">
            <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary text-center">
              {t('pose.coreIdea')}
            </h3>
            <p className="text-text-secondary font-body leading-relaxed text-lg text-center max-w-3xl mx-auto">
              {t('pose.coreText')}
            </p>
          </div>

          <div className="mb-12">
            <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary text-center">
              {t('pose.types')}
            </h3>
            <div className="space-y-4 max-w-3xl mx-auto">
              <ChallengeTypeCard
                type="U"
                name={t('pose.typeU')}
                detail="低成本,2.5秒超时"
                color="cyan"
                delay="0"
              />
              <ChallengeTypeCard
                type="S"
                name={t('pose.typeS')}
                detail="中等成本,6秒超时"
                color="blue"
                delay="0.1"
              />
              <ChallengeTypeCard
                type="R"
                name={t('pose.typeR')}
                detail="谨慎使用;最低权重"
                color="purple"
                delay="0.2"
              />
            </div>
          </div>

          <div className="mb-12">
            <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary text-center">
              {t('pose.frequency')}
            </h3>
            <div className="bg-bg-elevated p-8 rounded-xl border border-accent-cyan/30 noise-texture max-w-3xl mx-auto">
              <ul className="space-y-3 text-text-secondary font-body">
                <li className="flex items-start gap-2">
                  <span className="text-accent-cyan mt-1">▸</span>
                  <span>{t('pose.freqU')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-accent-blue mt-1">▸</span>
                  <span>{t('pose.freqS')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-accent-purple mt-1">▸</span>
                  <span>{t('pose.freqR')}</span>
                </li>
              </ul>
              <div className="mt-6 pt-6 border-t border-text-muted/20">
                <p className="font-display font-semibold text-text-primary mb-3">
                  {t('pose.threshold')}
                </p>
                <div className="text-text-secondary font-body space-y-2">
                  <p>• {t('pose.thresholdU')}</p>
                  <p>• {t('pose.thresholdS')}</p>
                </div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary text-center">
              {t('pose.scoring')}
            </h3>
            <div className="bg-bg-elevated p-8 rounded-xl border border-accent-blue/30 noise-texture space-y-6 max-w-3xl mx-auto">
              <div className="slide-in-right">
                <p className="font-display font-semibold text-text-primary mb-3">
                  正常运行时间/RPC分数:
                </p>
                <div className="font-display text-sm text-accent-cyan bg-bg-primary/50 p-4 rounded-lg border border-accent-cyan/20">
                  S<sub>u,i</sub> = u<sub>i</sub> × (0.85 + 0.15 × lat<sub>i</sub>)
                </div>
                <p className="text-sm text-text-muted font-body mt-3">
                  其中 u<sub>i</sub> = 通过率, lat<sub>i</sub> = 延迟因子 (防止带宽军备竞赛)
                </p>
              </div>

              <div className="slide-in-right" style={{ animationDelay: '0.1s' }}>
                <p className="font-display font-semibold text-text-primary mb-3">
                  存储分数 (SN):
                </p>
                <div className="font-display text-sm text-accent-cyan bg-bg-primary/50 p-4 rounded-lg border border-accent-cyan/20">
                  S<sub>s,i</sub> = s<sub>i</sub> × cap<sub>i</sub>
                </div>
                <p className="text-sm text-text-muted font-body mt-3">
                  cap<sub>i</sub> = √(min(storedGB, 500GB) / 500GB) — 收益递减
                </p>
              </div>

              <div className="slide-in-right" style={{ animationDelay: '0.2s' }}>
                <p className="font-display font-semibold text-text-primary mb-3">
                  中继分数 (RN):
                </p>
                <div className="font-display text-sm text-accent-cyan bg-bg-primary/50 p-4 rounded-lg border border-accent-cyan/20">
                  S<sub>r,i</sub> = pass<sub>r,i</sub> / total<sub>r,i</sub>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Anti-Cheat */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('antiCheat.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-12 rounded-full" />

          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            <ThreatCard
              title={t('antiCheat.sybil')}
              mitigation={t.raw('antiCheat.sybilMit') as string[]}
              delay="0"
            />
            <ThreatCard
              title={t('antiCheat.forgery')}
              mitigation={t.raw('antiCheat.forgeryMit') as string[]}
              delay="0.1"
            />
            <ThreatCard
              title={t('antiCheat.collusion')}
              mitigation={t.raw('antiCheat.collusionMit') as string[]}
              delay="0.2"
            />
            <ThreatCard
              title={t('antiCheat.network')}
              mitigation={t.raw('antiCheat.networkMit') as string[]}
              delay="0.3"
            />
          </div>
        </section>

        {/* AI Agent */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('agent.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-12 rounded-full" />

          <div className="grid md:grid-cols-2 gap-6 mb-8 max-w-4xl mx-auto">
            <div className="bg-bg-elevated p-8 rounded-xl border border-accent-cyan/30 noise-texture relative overflow-hidden slide-in-right">
              <div className="absolute inset-0 bg-gradient-to-br from-accent-cyan/5 to-transparent" />
              <h3 className="text-xl font-display font-semibold mb-6 text-accent-cyan relative flex items-center gap-2">
                <span className="text-2xl">✅</span> {t('agent.canDo')}
              </h3>
              <ul className="space-y-3 text-text-secondary font-body relative">
                <li className="flex items-start gap-2">
                  <span className="text-accent-cyan mt-1">✓</span>
                  <span>{t('agent.can1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-accent-cyan mt-1">✓</span>
                  <span>{t('agent.can2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-accent-cyan mt-1">✓</span>
                  <span>{t('agent.can3')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-accent-cyan mt-1">✓</span>
                  <span>{t('agent.can4')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-accent-cyan mt-1">✓</span>
                  <span>{t('agent.can5')}</span>
                </li>
              </ul>
            </div>

            <div className="bg-bg-elevated p-8 rounded-xl border border-pink-500/30 noise-texture relative overflow-hidden slide-in-right" style={{ animationDelay: '0.1s' }}>
              <div className="absolute inset-0 bg-gradient-to-br from-pink-500/5 to-transparent" />
              <h3 className="text-xl font-display font-semibold mb-6 text-pink-400 relative flex items-center gap-2">
                <span className="text-2xl">❌</span> {t('agent.cantDo')}
              </h3>
              <ul className="space-y-3 text-text-secondary font-body relative">
                <li className="flex items-start gap-2">
                  <span className="text-pink-400 mt-1">✗</span>
                  <span>{t('agent.cant1')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-pink-400 mt-1">✗</span>
                  <span>{t('agent.cant2')}</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-pink-400 mt-1">✗</span>
                  <span>{t('agent.cant3')}</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="bg-bg-elevated p-6 rounded-xl border border-accent-blue/30 noise-texture max-w-4xl mx-auto relative overflow-hidden fade-in-delay-2">
            <div className="absolute inset-0 bg-gradient-to-r from-accent-blue/5 to-transparent" />
            <p className="text-text-primary font-display font-semibold flex items-center gap-3 relative">
              <span className="text-2xl">⚡</span>
              <span>{t('agent.note')}</span>
            </p>
          </div>
        </section>

        {/* Release Plan */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('release.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-12 rounded-full" />

          <div className="space-y-8 max-w-5xl mx-auto">
            <PhaseCard
              phase="1"
              title={t('release.phase1.title')}
              status={t('release.phase1.status')}
              timeline={t('release.phase1.timeline')}
              features={t.raw('release.phase1.features') as string[]}
              delay="0"
            />
            <PhaseCard
              phase="2"
              title={t('release.phase2.title')}
              status={t('release.phase2.status')}
              timeline={t('release.phase2.timeline')}
              features={t.raw('release.phase2.features') as string[]}
              delay="0.1"
            />
            <PhaseCard
              phase="3"
              title={t('release.phase3.title')}
              status={t('release.phase3.status')}
              timeline={t('release.phase3.timeline')}
              features={t.raw('release.phase3.features') as string[]}
              delay="0.2"
            />
          </div>

          <div className="mt-12 bg-bg-elevated p-8 rounded-xl border border-accent-purple/30 noise-texture max-w-5xl mx-auto relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-r from-accent-purple/5 to-transparent" />
            <h3 className="text-xl font-display font-semibold mb-4 text-accent-purple relative flex items-center gap-2">
              <span className="text-2xl">🔐</span> {t('release.security.title')}
            </h3>
            <ul className="space-y-2 text-text-secondary font-body relative">
              {(t.raw('release.security.measures') as string[]).map((measure, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-accent-cyan mt-1">✓</span>
                  <span>{measure}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Testnet Deployment */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('testnet.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-12 rounded-full" />

          <div className="space-y-8 max-w-5xl mx-auto">
            {/* Requirements */}
            <div className="slide-in-right">
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('testnet.requirements.title')}
              </h3>
              <div className="grid md:grid-cols-2 gap-6">
                <RequirementCard
                  title={t('testnet.requirements.minimum.title')}
                  specs={t.raw('testnet.requirements.minimum.specs') as string[]}
                  type="minimum"
                />
                <RequirementCard
                  title={t('testnet.requirements.recommended.title')}
                  specs={t.raw('testnet.requirements.recommended.specs') as string[]}
                  type="recommended"
                />
              </div>
            </div>

            {/* Quick Start */}
            <div className="slide-in-right" style={{ animationDelay: '0.1s' }}>
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('testnet.quickStart.title')}
              </h3>
              <div className="bg-bg-elevated p-8 rounded-xl border border-accent-cyan/30 noise-texture space-y-6">
                {(t.raw('testnet.quickStart.steps') as Array<{ step: string; command: string; desc: string }>).map(
                  (item, idx) => (
                    <StepCard key={idx} step={item.step} command={item.command} description={item.desc} index={idx} />
                  )
                )}
              </div>
            </div>

            {/* Multi-node Setup */}
            <div className="slide-in-right" style={{ animationDelay: '0.2s' }}>
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('testnet.multiNode.title')}
              </h3>
              <div className="bg-bg-elevated p-8 rounded-xl border border-accent-blue/30 noise-texture">
                <p className="text-text-secondary font-body mb-6">{t('testnet.multiNode.intro')}</p>
                <div className="space-y-4">
                  {(t.raw('testnet.multiNode.configs') as Array<{ nodes: string; command: string }>).map(
                    (config, idx) => (
                      <div
                        key={idx}
                        className="bg-bg-primary/50 p-4 rounded-lg border border-accent-blue/20 hover:border-accent-blue/40 transition-all"
                      >
                        <p className="text-sm font-display text-accent-blue mb-2">{config.nodes}</p>
                        <code className="text-sm text-text-secondary font-mono block overflow-x-auto">
                          {config.command}
                        </code>
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>

            {/* Rewards */}
            <div className="slide-in-right" style={{ animationDelay: '0.3s' }}>
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('testnet.rewards.title')}
              </h3>
              <div className="bg-gradient-to-br from-accent-cyan/10 via-accent-blue/10 to-accent-purple/10 p-8 rounded-xl border border-accent-cyan/30 noise-texture">
                <ul className="space-y-3 text-text-secondary font-body">
                  {(t.raw('testnet.rewards.items') as string[]).map((reward, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-accent-cyan mt-1">🎁</span>
                      <span>{reward}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Development Participation */}
        <section className="mb-20 fade-in-up">
          <h2 className="text-3xl md:text-4xl font-display font-bold mb-6 text-center">
            <span className="gradient-text">{t('development.title')}</span>
          </h2>
          <div className="w-24 h-1 bg-gradient-cyber mx-auto mb-12 rounded-full" />

          <div className="space-y-8 max-w-5xl mx-auto">
            {/* How to Contribute */}
            <div className="slide-in-right">
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('development.contribute.title')}
              </h3>
              <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
                {(t.raw('development.contribute.areas') as Array<{ area: string; desc: string }>).map((area, idx) => (
                  <ContributeCard key={idx} area={area.area} description={area.desc} delay={idx * 0.1} />
                ))}
              </div>
            </div>

            {/* Process */}
            <div className="slide-in-right" style={{ animationDelay: '0.1s' }}>
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('development.process.title')}
              </h3>
              <div className="bg-bg-elevated p-8 rounded-xl border border-accent-cyan/30 noise-texture">
                <ol className="space-y-4">
                  {(t.raw('development.process.steps') as string[]).map((step, idx) => (
                    <li key={idx} className="flex items-start gap-4">
                      <div className="bg-gradient-cyber text-white rounded-full w-8 h-8 flex items-center justify-center font-display font-bold flex-shrink-0 text-sm">
                        {idx + 1}
                      </div>
                      <p className="text-text-secondary font-body pt-1">{step}</p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            {/* Tech Stack */}
            <div className="slide-in-right" style={{ animationDelay: '0.2s' }}>
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('development.techStack.title')}
              </h3>
              <div className="grid md:grid-cols-2 gap-6">
                {(t.raw('development.techStack.categories') as Array<{ category: string; items: string[] }>).map(
                  (cat, idx) => (
                    <TechStackCard key={idx} category={cat.category} items={cat.items} />
                  )
                )}
              </div>
            </div>

            {/* Resources */}
            <div className="slide-in-right" style={{ animationDelay: '0.3s' }}>
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('development.resources.title')}
              </h3>
              <div className="grid md:grid-cols-3 gap-6">
                {(t.raw('development.resources.links') as Array<{ name: string; url: string; desc: string }>).map(
                  (link, idx) => (
                    <ResourceCard key={idx} name={link.name} url={link.url} description={link.desc} />
                  )
                )}
              </div>
            </div>

            {/* Grants */}
            <div className="slide-in-right" style={{ animationDelay: '0.4s' }}>
              <h3 className="text-2xl font-display font-semibold mb-6 text-text-primary">
                {t('development.grants.title')}
              </h3>
              <div className="bg-gradient-to-br from-accent-purple/10 via-accent-blue/10 to-accent-cyan/10 p-8 rounded-xl border border-accent-purple/30 noise-texture">
                <p className="text-text-secondary font-body mb-6">{t('development.grants.intro')}</p>
                <ul className="space-y-3 text-text-secondary font-body">
                  {(t.raw('development.grants.programs') as string[]).map((program, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-accent-purple mt-1">💎</span>
                      <span>{program}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-20 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-accent-cyan/10 via-accent-blue/10 to-accent-purple/10" />
          <div className="absolute inset-0 noise-texture" />

          <div className="container mx-auto px-4 text-center relative z-10">
            <h2 className="text-3xl md:text-4xl font-display font-bold mb-12 fade-in-up">
              <span className="gradient-text">{t('cta.title')}</span>
            </h2>
            <div className="flex flex-col sm:flex-row gap-6 justify-center fade-in-delay-1">
              <a
                href="/technology"
                className="group relative px-8 py-4 rounded-lg font-display font-semibold text-lg overflow-hidden transition-all hover:scale-105"
              >
                <div className="absolute inset-0 bg-gradient-cyber opacity-100 group-hover:opacity-90 transition-opacity" />
                <div className="absolute inset-0 bg-gradient-cyber blur-xl opacity-50 group-hover:opacity-75 transition-opacity" />
                <span className="relative text-white">&gt; {t('cta.technology')}</span>
              </a>

              <a
                href="/roadmap"
                className="group px-8 py-4 rounded-lg font-display font-semibold text-lg border-2 border-accent-cyan/50 bg-accent-cyan/5 hover:bg-accent-cyan/10 hover:border-accent-cyan transition-all hover:shadow-glow-md backdrop-blur-sm"
              >
                <span className="text-accent-cyan group-hover:text-accent-cyan/90">
                  {t('cta.roadmap')} →
                </span>
              </a>

              <a
                href="/docs"
                className="group px-8 py-4 rounded-lg font-display font-semibold text-lg border-2 border-text-muted/30 hover:border-text-secondary/50 transition-all hover:bg-bg-elevated/50 backdrop-blur-sm"
              >
                <span className="text-text-secondary group-hover:text-text-primary">
                  {t('cta.docs')}
                </span>
              </a>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function GoalCard({
  number,
  title,
  description,
  delay,
}: {
  number: string
  title: string
  description: string
  delay: string
}) {
  return (
    <div
      className="group bg-bg-elevated p-6 rounded-xl border-l-4 border-accent-cyan noise-texture relative overflow-hidden hover:border-accent-blue transition-all duration-500 hover:shadow-glow-md fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 transition-opacity duration-500" />
      <div className="flex items-start gap-4 relative">
        <div className="bg-gradient-cyber text-white rounded-full w-10 h-10 flex items-center justify-center font-display font-bold flex-shrink-0 group-hover:scale-110 transition-transform duration-500">
          {number}
        </div>
        <div>
          <h4 className="font-display font-semibold text-text-primary group-hover:text-accent-cyan transition-colors mb-2">
            {title}
          </h4>
          <p className="text-sm text-text-secondary font-body leading-relaxed">{description}</p>
        </div>
      </div>
    </div>
  )
}

function BucketCard({ title, percentage, color }: { title: string; percentage: string; color: string }) {
  const colorMap: Record<string, { gradient: string; text: string; border: string }> = {
    cyan: { gradient: 'from-accent-cyan to-accent-blue', text: 'text-accent-cyan', border: 'border-accent-cyan/50' },
    blue: { gradient: 'from-accent-blue to-accent-purple', text: 'text-accent-blue', border: 'border-accent-blue/50' },
    purple: { gradient: 'from-accent-purple to-pink-500', text: 'text-accent-purple', border: 'border-accent-purple/50' },
  }

  const colors = colorMap[color]

  return (
    <div className="group bg-bg-elevated p-8 rounded-xl border border-text-muted/10 hover:border-accent-cyan/50 noise-texture transition-all duration-500 hover:shadow-glow-md">
      <div className={`bg-gradient-to-r ${colors.gradient} text-white text-3xl font-display font-bold py-4 rounded-lg mb-4 text-center group-hover:scale-105 transition-transform duration-500 shadow-lg`}>
        {percentage}
      </div>
      <p className={`text-center ${colors.text} font-display font-semibold text-lg`}>{title}</p>
    </div>
  )
}

function ChallengeTypeCard({
  type,
  name,
  detail,
  color,
  delay,
}: {
  type: string
  name: string
  detail: string
  color: string
  delay: string
}) {
  const colorMap: Record<string, { bg: string; text: string; border: string }> = {
    cyan: { bg: 'bg-accent-cyan', text: 'text-accent-cyan', border: 'border-accent-cyan/50' },
    blue: { bg: 'bg-accent-blue', text: 'text-accent-blue', border: 'border-accent-blue/50' },
    purple: { bg: 'bg-accent-purple', text: 'text-accent-purple', border: 'border-accent-purple/50' },
  }

  const colors = colorMap[color]

  return (
    <div
      className="group flex items-center gap-6 bg-bg-elevated p-6 rounded-xl border border-text-muted/10 hover:border-accent-cyan/50 noise-texture transition-all duration-500 hover:shadow-glow-md slide-in-right"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />
      <div
        className={`${colors.bg} text-white rounded-lg font-display font-bold w-14 h-14 flex items-center justify-center flex-shrink-0 text-xl group-hover:scale-110 transition-transform duration-500 shadow-lg relative`}
      >
        {type}
      </div>
      <div className="relative">
        <h4 className="font-display font-semibold text-text-primary mb-1 group-hover:text-accent-cyan transition-colors">
          {name}
        </h4>
        <p className="text-sm text-text-muted font-body">{detail}</p>
      </div>
    </div>
  )
}

function ThreatCard({
  title,
  mitigation,
  mitigationLabel,
  delay,
}: {
  title: string
  mitigation: string[]
  mitigationLabel?: string
  delay: string
}) {
  return (
    <div
      className="group bg-bg-elevated p-8 rounded-xl border border-pink-500/30 noise-texture relative overflow-hidden hover:border-pink-500/50 transition-all duration-500 hover:shadow-glow-md fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-pink-500/5 to-transparent" />
      <h3 className="text-lg font-display font-bold mb-4 text-pink-400 flex items-center gap-2 relative">
        <span className="text-xl">🔒</span>
        <span>{title}</span>
      </h3>
      <p className="text-sm font-display font-semibold text-text-muted mb-3 relative">
        {mitigationLabel || '缓解措施:'}
      </p>
      <ul className="space-y-2 relative">
        {mitigation.map((item, idx) => (
          <li key={idx} className="text-sm text-text-secondary font-body flex items-start gap-2">
            <span className="text-accent-cyan mt-1">✓</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PhaseCard({
  phase,
  title,
  status,
  timeline,
  features,
  delay,
}: {
  phase: string
  title: string
  status: string
  timeline: string
  features: string[]
  delay: string
}) {
  return (
    <div
      className="group bg-bg-elevated p-8 rounded-xl border border-accent-cyan/30 noise-texture relative overflow-hidden hover:border-accent-cyan/50 transition-all duration-500 hover:shadow-glow-md slide-in-right"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 transition-opacity duration-500" />
      <div className="flex items-start justify-between mb-6 relative">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="bg-gradient-cyber text-white rounded-lg px-4 py-2 font-display font-bold">
              Phase {phase}
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-display font-semibold bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30">
              {status}
            </span>
          </div>
          <h3 className="text-2xl font-display font-bold text-text-primary group-hover:text-accent-cyan transition-colors">
            {title}
          </h3>
        </div>
        <div className="text-right">
          <p className="text-sm font-display text-text-muted">{timeline}</p>
        </div>
      </div>
      <ul className="space-y-2 relative">
        {features.map((feature, idx) => (
          <li key={idx} className="text-text-secondary font-body flex items-start gap-2">
            <span className="text-accent-cyan mt-1">✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RequirementCard({ title, specs, type }: { title: string; specs: string[]; type: string }) {
  const borderColor = type === 'recommended' ? 'border-accent-cyan/50' : 'border-text-muted/30'
  const bgGradient = type === 'recommended' ? 'from-accent-cyan/5' : 'from-transparent'

  return (
    <div className={`bg-bg-elevated p-6 rounded-xl border ${borderColor} noise-texture relative overflow-hidden hover:border-accent-cyan/50 transition-all duration-500`}>
      <div className={`absolute inset-0 bg-gradient-to-br ${bgGradient} to-transparent`} />
      <h4 className="text-lg font-display font-semibold text-text-primary mb-4 relative">{title}</h4>
      <ul className="space-y-2 relative">
        {specs.map((spec, idx) => (
          <li key={idx} className="text-sm text-text-secondary font-body flex items-start gap-2">
            <span className="text-accent-cyan mt-1">•</span>
            <span>{spec}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StepCard({ step, command, description, index }: { step: string; command: string; description: string; index: number }) {
  return (
    <div className="relative">
      <div className="flex items-start gap-4">
        <div className="bg-gradient-cyber text-white rounded-full w-8 h-8 flex items-center justify-center font-display font-bold flex-shrink-0 text-sm">
          {index + 1}
        </div>
        <div className="flex-1">
          <p className="font-display font-semibold text-text-primary mb-2">{step}</p>
          <div className="bg-bg-primary/50 p-4 rounded-lg border border-accent-cyan/20 mb-2 overflow-x-auto">
            <code className="text-sm text-accent-cyan font-mono">{command}</code>
          </div>
          <p className="text-sm text-text-muted font-body">{description}</p>
        </div>
      </div>
    </div>
  )
}

function ContributeCard({ area, description, delay }: { area: string; description: string; delay: number }) {
  return (
    <div
      className="group bg-bg-elevated p-6 rounded-xl border border-text-muted/20 hover:border-accent-cyan/50 noise-texture transition-all duration-500 hover:shadow-glow-md fade-in-up"
      style={{ animationDelay: `${delay}s` }}
    >
      <div className="absolute inset-0 bg-gradient-cyber opacity-0 group-hover:opacity-5 rounded-xl transition-opacity duration-500" />
      <h4 className="font-display font-semibold text-text-primary group-hover:text-accent-cyan transition-colors mb-2 text-lg">
        {area}
      </h4>
      <p className="text-sm text-text-secondary font-body">{description}</p>
    </div>
  )
}

function TechStackCard({ category, items }: { category: string; items: string[] }) {
  return (
    <div className="bg-bg-elevated p-6 rounded-xl border border-accent-blue/30 noise-texture hover:border-accent-blue/50 transition-all duration-500">
      <h4 className="font-display font-semibold text-accent-blue mb-4">{category}</h4>
      <ul className="space-y-2">
        {items.map((item, idx) => (
          <li key={idx} className="text-sm text-text-secondary font-body flex items-start gap-2">
            <span className="text-accent-cyan mt-1">▸</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ResourceCard({ name, url, description }: { name: string; url: string; description: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group bg-bg-elevated p-6 rounded-xl border border-text-muted/20 hover:border-accent-cyan/50 noise-texture transition-all duration-500 hover:shadow-glow-md block"
    >
      <h4 className="font-display font-semibold text-text-primary group-hover:text-accent-cyan transition-colors mb-2 flex items-center gap-2">
        {name}
        <span className="text-xs opacity-50 group-hover:opacity-100 transition-opacity">↗</span>
      </h4>
      <p className="text-sm text-text-secondary font-body">{description}</p>
    </a>
  )
}

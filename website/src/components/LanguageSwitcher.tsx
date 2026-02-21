'use client'

import { useLocale } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/routing'
import { useState, useTransition } from 'react'

const languages = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'zh', name: '中文', flag: '🇨🇳' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'ja', name: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: '한국어', flag: '🇰🇷' },
]

export function LanguageSwitcher() {
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()
  const [isOpen, setIsOpen] = useState(false)

  const currentLanguage = languages.find((lang) => lang.code === locale) || languages[0]

  const handleLanguageChange = (newLocale: string) => {
    startTransition(() => {
      router.replace(pathname, { locale: newLocale })
      setIsOpen(false)
    })
  }

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="group flex items-center gap-2 px-3 py-2 rounded-lg bg-accent-cyan/5 border border-accent-cyan/20 hover:bg-accent-cyan/10 hover:border-accent-cyan/40 transition-all font-display"
        disabled={isPending}
      >
        <span className="text-xl filter grayscale-0">{currentLanguage.flag}</span>
        <span className="hidden sm:inline text-sm text-text-secondary group-hover:text-accent-cyan transition-colors">
          {currentLanguage.name}
        </span>
        <svg
          className={`w-4 h-4 text-text-muted group-hover:text-accent-cyan transition-all ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />

          {/* Dropdown */}
          <div className="absolute right-0 mt-2 w-56 bg-bg-elevated rounded-xl shadow-glow-md border border-accent-cyan/20 z-50 overflow-hidden backdrop-blur-xl">
            {languages.map((lang, index) => (
              <button
                key={lang.code}
                onClick={() => handleLanguageChange(lang.code)}
                className={`group w-full flex items-center gap-3 px-4 py-3 hover:bg-accent-cyan/10 transition-all ${
                  lang.code === locale
                    ? 'bg-accent-cyan/5 text-accent-cyan border-l-2 border-accent-cyan'
                    : 'text-text-secondary hover:text-text-primary border-l-2 border-transparent'
                } ${index === 0 ? 'rounded-t-xl' : ''} ${index === languages.length - 1 ? 'rounded-b-xl' : ''}`}
              >
                <span className="text-2xl filter grayscale group-hover:grayscale-0 transition-all">{lang.flag}</span>
                <span className="font-display font-medium text-sm flex-1 text-left">{lang.name}</span>
                {lang.code === locale && (
                  <svg className="w-5 h-5 text-accent-cyan" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

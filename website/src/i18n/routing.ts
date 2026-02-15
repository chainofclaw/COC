import { defineRouting } from 'next-intl/routing'
import { createNavigation } from 'next-intl/navigation'

export const routing = defineRouting({
  // A list of all locales that are supported
  locales: ['en', 'zh', 'es', 'ja', 'ko'],

  // Used when no locale matches
  defaultLocale: 'en',

  // Always use a locale prefix
  localePrefix: 'always'
})

// Lightweight wrappers around Next.js' navigation APIs
// that will consider the routing configuration
export const { Link, redirect, usePathname, useRouter } =
  createNavigation(routing)

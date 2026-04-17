'use client'

import { useState } from 'react'
import { Link } from '@/i18n/routing'

type MenuItem = { href: string; label: string }

export function MobileMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen(!open)}
        className="text-text-primary hover:text-accent-cyan transition-colors p-1"
        aria-label="Menu"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {open ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <nav className="fixed top-[68px] left-0 right-0 z-50 bg-bg-secondary border-b border-text-muted/20 py-3 px-4 space-y-1 shadow-lg shadow-black/40">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="block px-4 py-3 rounded-lg text-text-secondary hover:text-accent-cyan hover:bg-accent-cyan/5 font-body text-base transition-all"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </>
      )}
    </div>
  )
}

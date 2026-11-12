import type { ReactNode } from 'react'
import { BrandMark } from '../components/BrandMark'

/** The sign-in page's look, for the Mac app's sign-in pages. */
export function DesktopPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-clip p-6">
      <main className="shell-main relative w-full max-w-sm">
        <BrandMark className="size-11" />
        <h1 className="mt-5 mb-3 font-display text-[2.1rem] leading-tight font-semibold tracking-tight text-ink [font-variation-settings:'opsz'_96]">
          {title}
        </h1>
        {children}
      </main>
    </div>
  )
}

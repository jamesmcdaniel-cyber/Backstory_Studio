import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { ClientProviders } from '@/components/providers/client-providers'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'SprintIQ',
  description: 'Build, run, and review AI agents connected to your tools.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ClientProviders>
          <main id="main-content">{children}</main>
        </ClientProviders>
      </body>
    </html>
  )
}

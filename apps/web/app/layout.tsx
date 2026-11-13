import './globals.css';

import type { Metadata, Viewport } from 'next';
import type { ReactElement, ReactNode } from 'react';

import { ServiceWorkerRegister } from '../components/service-worker-register';

export const metadata: Metadata = {
  title: 'K2 Group',
  description: 'K2 Group platform foundation. No trading, accounts, or payments in this module.',
  applicationName: 'K2 Group',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    title: 'K2 Group',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#0e1214',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#content">
          Skip to content
        </a>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}

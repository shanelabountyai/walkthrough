// public: the offline app shell holds no data; every byte of data comes from the guarded feed and sync endpoints (requireOrg)
import { FieldApp } from './field-app';

export const metadata = { title: 'Walkthrough field app', manifest: '/manifest.webmanifest' };
export const dynamic = 'force-static'; // the service worker caches this exact HTML for offline opens

export default function Field() {
  return <FieldApp />;
}

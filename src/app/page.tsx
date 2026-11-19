// public: the landing page
import Link from 'next/link';
import { demoEnabled } from '@/core/auth/demo';
import { Logo } from '@/app/ui/logo';

export const dynamic = 'force-dynamic'; // reads DEMO_MODE per request, never baked in at build

export default function Home() {
  return (
    <>
      <header className="wt-top">
        <div className="wt-top-in">
          <span className="wt-brand">
            <Logo />
            <span>Walkthrough</span>
          </span>
        </div>
      </header>
      <main className="wt-page">
        <div className="wt-narrow-col" style={{ maxWidth: 640 }}>
          <h1 className="wt-h1">Inspections that work without signal</h1>
          <p className="wt-note-14">
            Technicians run checklists, take photos and capture a customer signature on their phone, offline. Everything syncs when there is signal, and
            two people changing the same answer is shown, never silently overwritten. A learning project with synthetic data only.
          </p>
          <div className="wt-row-btns">
            <Link className="wt-btn" href="/login">Sign in</Link>
            {demoEnabled() && <Link className="wt-btn wt-btn-2" href="/demo">Demo accounts</Link>}
          </div>
          <footer className="wt-note">
            <Link href="/legal/privacy">Privacy</Link> · <Link href="/legal/terms">Terms</Link>
          </footer>
        </div>
      </main>
    </>
  );
}

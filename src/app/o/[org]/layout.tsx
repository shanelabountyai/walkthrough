import Link from 'next/link';
import { can } from '@/core/authz/permissions';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { truckrollLink } from '@/lib/walkthrough/truckroll';
import { Logo } from '@/app/ui/logo';
import { NavLink } from '@/app/ui/nav-link';

// Navigation only. Layouts do not re-run on every navigation, so each page calls requireOrg itself.
// Design pass 2026-11-18 (Admin artboard): navy header, the product's own pages first, the org's settings in a second row.
export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ org: string }> }) {
  const ctx = await requireOrg((await params).org);
  const org = await db.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } });
  const base = `/o/${ctx.slug}`;
  return (
    <>
      <a className="wt-skip" href="#content">Skip to content</a>
      <header className="wt-top">
        {/* One navigation landmark (the template's e2e reads the org name and the settings links from it). */}
        <nav aria-label="Main" className="wt-top-in">
          <div className="wt-navwrap">
            <Link href={`${base}/inspections`} className="wt-brand" style={{ color: '#fff', textDecoration: 'none', minHeight: 44 }}>
              <Logo />
              <span>{org.name} · Walkthrough</span>
            </Link>
            <div className="wt-nav">
              <NavLink href={`${base}/inspections`}>Inspections</NavLink>
              {can(ctx.role, 'org.update') && <NavLink href={`${base}/templates`}>Templates</NavLink>}
              <a href={`/field?org=${encodeURIComponent(ctx.slug)}`}>Field app</a>
              <a href={truckrollLink(ctx.slug, new Date())} target="_blank" rel="noopener noreferrer">Dispatch (Truckroll)<span className="wt-sr"> (opens in a new tab)</span></a>
            </div>
          </div>
          <div className="wt-nav wt-nav-2" aria-label="Org settings" role="group">
            <NavLink href={`${base}/projects`}>Projects</NavLink>
            <NavLink href={`${base}/settings/members`}>Members</NavLink>
            {can(ctx.role, 'audit.read') && <><NavLink href={`${base}/settings/audit`}>Audit log</NavLink><NavLink href={`${base}/settings/security`}>Security</NavLink></>}
            {ctx.role === 'owner' && <NavLink href={`${base}/settings/sso`}>SSO</NavLink>} {/* sso */}
            {can(ctx.role, 'apikeys.manage') && <NavLink href={`${base}/settings/apikeys`}>API keys</NavLink>} {/* apikeys */}
            {can(ctx.role, 'org.delete') && <NavLink href={`${base}/settings/danger`}>Export or delete</NavLink>}
            <Link href="/onboarding">Your orgs</Link>
            <Link href="/account/security">Account</Link>
          </div>
        </nav>
      </header>
      <div id="content">{children}</div>
    </>
  );
}

'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** An office nav link that marks itself `aria-current="page"` on its own section (design pass, Admin artboard). */
export function NavLink({ href, children, exact = false }: { href: string; children: React.ReactNode; exact?: boolean }) {
  const path = usePathname() ?? '';
  const here = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link href={href} aria-current={here ? 'page' : undefined}>
      {children}
    </Link>
  );
}

'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const links = [
  { href: '/jobs', label: 'Jobs' },
  { href: '/accounts', label: 'Accounts' },
];

export function Shell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (auth.status === 'anonymous') {
      router.replace('/login');
    }
  }, [auth.status, router]);

  if (auth.status !== 'ready') {
    return <p className="px-6 py-10 text-sm text-muted-foreground">Checking session…</p>;
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/jobs" className="text-sm font-semibold tracking-tight">
            Fireweave
          </Link>
          <nav className="flex items-center gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-sm',
                  pathname.startsWith(link.href)
                    ? 'bg-accent font-medium'
                    : 'text-muted-foreground',
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {auth.user?.email}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void auth.signOut().then(() => router.replace('/login'));
              }}
            >
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

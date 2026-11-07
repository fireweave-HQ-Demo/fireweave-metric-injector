'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/components/auth-provider';

export default function HomePage() {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (auth.status === 'loading') {
      return;
    }
    router.replace(auth.status === 'ready' ? '/jobs' : '/login');
  }, [auth.status, router]);
  return <p className="px-6 py-10 text-sm text-muted-foreground">Opening Fireweave…</p>;
}

import type { Metadata } from 'next';

// Kept out of search results, but crawlers may follow the "Powered by <Div/>" credit (see CLAUDE.md).
export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

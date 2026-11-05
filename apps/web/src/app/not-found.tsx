import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center p-6 text-center">
      <div className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-xl font-semibold">This page does not exist</h1>
        <Link href="/admin" className="text-sm text-primary underline-offset-4 hover:underline">
          Back to the panel
        </Link>
      </div>
    </main>
  );
}

import type { ReactNode } from 'react';
import { Button } from './button';
import { Skeleton } from './skeleton';
import { cn } from '@/lib/utils';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Hidden in the phone card layout. */
  hideOnMobile?: boolean;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  caption?: string;
  /** No outer border: the table sits inside a Card that already has one. */
  bare?: boolean;
}

/** Table on wider screens; each row becomes a labelled card under 640 px (same DOM, CSS only). */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  onRowClick,
  hasMore,
  loadingMore,
  onLoadMore,
  caption,
  bare,
}: Props<T>) {
  const card = bare
    ? 'max-sm:block max-sm:px-4 max-sm:py-3'
    : 'max-sm:block max-sm:rounded-2xl max-sm:border max-sm:bg-card max-sm:p-4';
  return (
    <div className="space-y-3">
      <div
        className={cn(
          'overflow-x-auto bg-card max-sm:overflow-visible max-sm:bg-transparent',
          bare ? '' : 'rounded-2xl border max-sm:border-0',
        )}
      >
        <table className="w-full text-sm max-sm:block">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="sticky top-0 z-[1] bg-subtle text-left max-sm:hidden">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    'eyebrow px-3 py-2.5 font-medium tracking-[0.08em] whitespace-nowrap first:pl-5 last:pr-5',
                    c.className,
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            className={cn(
              'divide-y divide-divider max-sm:block',
              !bare && 'max-sm:space-y-2 max-sm:divide-y-0',
            )}
          >
            {loading
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i} className={card}>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className="h-[52px] px-3 first:pl-5 last:pr-5 max-sm:block max-sm:h-auto max-sm:px-0 max-sm:first:pl-0 max-sm:last:pr-0 max-sm:py-1"
                      >
                        <Skeleton className="h-4 w-full max-w-40" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows?.map((r) => (
                  <tr
                    key={rowKey(r)}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    className={cn(card, onRowClick && 'cursor-pointer hover:bg-subtle')}
                  >
                    {columns.map((c, i) => (
                      <td
                        key={c.key}
                        data-label={typeof c.header === 'string' ? c.header : undefined}
                        className={cn(
                          'h-[52px] px-3 py-2.5 align-middle text-foreground first:pl-5 last:pr-5',
                          'max-sm:flex max-sm:h-auto max-sm:items-baseline max-sm:justify-between max-sm:gap-4 max-sm:px-0 max-sm:py-1 max-sm:first:pl-0 max-sm:last:pr-0',
                          i > 0 &&
                            'max-sm:before:text-xs max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]',
                          i === 0 && 'max-sm:font-semibold',
                          c.hideOnMobile && 'max-sm:hidden',
                          c.className,
                        )}
                      >
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
        {!loading && rows?.length === 0 ? (
          <div
            className={cn(
              'px-4 py-12 text-center text-sm text-muted-foreground',
              !bare && 'max-sm:rounded-2xl max-sm:border max-sm:bg-card',
            )}
          >
            {empty ?? 'Nothing here yet.'}
          </div>
        ) : null}
      </div>
      {hasMore ? (
        <div className={cn('flex justify-center', bare && 'pb-4')}>
          <Button variant="outline" size="sm" onClick={onLoadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

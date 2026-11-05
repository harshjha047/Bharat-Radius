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
}: Props<T>) {
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border bg-card max-sm:border-0 max-sm:bg-transparent">
        <table className="w-full text-sm max-sm:block">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground max-sm:hidden">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('px-3 py-2 font-medium', c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y max-sm:block max-sm:space-y-2 max-sm:divide-y-0">
            {loading
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr
                    key={i}
                    className="max-sm:block max-sm:rounded-lg max-sm:border max-sm:bg-card max-sm:p-3"
                  >
                    {columns.map((c) => (
                      <td key={c.key} className="px-3 py-3 max-sm:block max-sm:px-0 max-sm:py-1">
                        <Skeleton className="h-4 w-full max-w-40" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows?.map((r) => (
                  <tr
                    key={rowKey(r)}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    className={cn(
                      'max-sm:block max-sm:rounded-lg max-sm:border max-sm:bg-card max-sm:p-3',
                      onRowClick && 'cursor-pointer hover:bg-muted/50',
                    )}
                  >
                    {columns.map((c, i) => (
                      <td
                        key={c.key}
                        data-label={typeof c.header === 'string' ? c.header : undefined}
                        className={cn(
                          'px-3 py-2.5 align-middle',
                          'max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-4 max-sm:px-0 max-sm:py-1',
                          i > 0 &&
                            'max-sm:before:text-xs max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]',
                          i === 0 && 'max-sm:font-medium',
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
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {empty ?? 'Nothing here yet.'}
          </div>
        ) : null}
      </div>
      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onLoadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

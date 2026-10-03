import { useState, type ReactNode } from 'react';

/**
 * The one table in Pebble.
 *
 * Every column is sortable (a column you cannot sort is a bug), rows are capped
 * with a "show more" rather than rendering hundreds at once, and a row can be
 * clicked through to detail.
 */
export interface Column<T, K extends string> {
  /** Sort key. Omit to make the column display-only (e.g. a sparkline). */
  key?: K;
  header: string;
  /** Right-aligned with tabular figures. Use for anything numeric. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
  /** Tooltip on the header, for a column whose meaning is not obvious. */
  title?: string;
}

export interface DataTableProps<T, K extends string> {
  rows: T[];
  columns: Column<T, K>[];
  rowKey: (row: T) => string;
  sortKey: K;
  sortDirection: 'asc' | 'desc';
  onSort: (key: K) => void;
  onRowClick?: (row: T) => void;
  isSelected?: (row: T) => boolean;
  /** Rows shown before the "show more" toggle. */
  pageSize?: number;
  compact?: boolean;
  empty?: ReactNode;
}

export function DataTable<T, K extends string>(props: DataTableProps<T, K>): ReactNode {
  const pageSize = props.pageSize ?? 10;
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? props.rows : props.rows.slice(0, pageSize);
  const hidden = props.rows.length - visible.length;

  if (props.rows.length === 0) {
    return <p className="empty">{props.empty ?? 'Nothing here.'}</p>;
  }

  return (
    <div className="table-wrap">
      <table className={`t${props.compact ? ' t--compact' : ''}`}>
        <thead>
          <tr>
            {props.columns.map((column, index) => {
              const sorted = column.key !== undefined && column.key === props.sortKey;
              return (
                <th
                  key={column.header || index}
                  className={column.numeric ? 'num' : undefined}
                  aria-sort={sorted ? (props.sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
                  title={column.title}
                >
                  {column.key === undefined ? (
                    column.header
                  ) : (
                    <button type="button" onClick={() => props.onSort(column.key as K)}>
                      {column.header}
                      {sorted && (
                        <span className="sort-caret" aria-hidden="true">
                          {props.sortDirection === 'asc' ? '▲' : '▼'}
                        </span>
                      )}
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const clickable = props.onRowClick !== undefined;
            return (
              <tr
                key={props.rowKey(row)}
                className={`${clickable ? 'is-clickable' : ''}${props.isSelected?.(row) ? ' is-selected' : ''}`.trim() || undefined}
                onClick={clickable ? () => props.onRowClick?.(row) : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          props.onRowClick?.(row);
                        }
                      }
                    : undefined
                }
              >
                {props.columns.map((column, index) => (
                  <td key={column.header || index} className={column.numeric ? 'num' : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {(hidden > 0 || expanded) && props.rows.length > pageSize && (
        <div className="t__more">
          <button type="button" className="btn btn--plain small" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'show fewer' : `show ${hidden} more`}
          </button>
        </div>
      )}
    </div>
  );
}

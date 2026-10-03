import { Fragment, useState, type ReactNode } from 'react';

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
  /** Dropped at phone width. For secondary columns, so the table fits without a sideways scroll. */
  wideOnly?: boolean;
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
  /**
   * Inline expansion: content rendered in a full-width row directly under its
   * parent, or null when the row is collapsed. The caller owns which rows are
   * open (usually by toggling in `onRowClick`). This is the alternative to a
   * modal, not a card — the content sits in the table's own flow.
   */
  expansion?: (row: T) => ReactNode | null;
}

function cellClass<T, K extends string>(column: Column<T, K>): string | undefined {
  const names = [column.numeric ? 'num' : '', column.wideOnly ? 't__wide' : ''].filter(Boolean);
  return names.length > 0 ? names.join(' ') : undefined;
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
                  className={cellClass(column)}
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
            const expansion = props.expansion?.(row) ?? null;
            const key = props.rowKey(row);
            return (
              <Fragment key={key}>
                <tr
                  className={
                    `${clickable ? 'is-clickable' : ''}${props.isSelected?.(row) || expansion !== null ? ' is-selected' : ''}`.trim() ||
                    undefined
                  }
                  onClick={clickable ? () => props.onRowClick?.(row) : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-expanded={props.expansion ? expansion !== null : undefined}
                  onKeyDown={
                    clickable
                      ? (event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            props.onRowClick?.(row);
                          }
                        }
                      : undefined
                  }
                >
                  {props.columns.map((column, index) => (
                    <td key={column.header || index} className={cellClass(column)}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {expansion !== null && (
                  <tr className="t__expansion">
                    <td colSpan={props.columns.length}>
                      <div className="t__expansion-body">{expansion}</div>
                    </td>
                  </tr>
                )}
              </Fragment>
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

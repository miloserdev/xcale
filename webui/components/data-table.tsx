"use client"

import * as React from "react"
import {
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table"
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  rowSelectionFeature,
})

// With `bulkActions` (or `onSelectionChange`) every row gets a checkbox, the header one
// selects all rows (of every page); `bulkActions` renders the buttons for the selected
// rows, `onSelectionChange` reports the selected rows (for a form).
export function DataTable<TData extends RowData>({
  columns,
  data,
  pageSize = 10,
  getRowId,
  bulkActions,
  initialSelected,
  onSelectionChange,
  toolbar,
}: {
  columns: ColumnDef<typeof features, TData>[]
  data: TData[]
  pageSize?: number
  getRowId?: (row: TData) => string
  bulkActions?: (selected: TData[], clear: () => void) => React.ReactNode
  initialSelected?: string[]
  // ids of all selected rows, also the ones a filter of `data` hides at the moment
  onSelectionChange?: (ids: string[]) => void
  toolbar?: React.ReactNode
}) {
  const selectable = !!bulkActions || !!onSelectionChange
  const allColumns = React.useMemo(
    () =>
      selectable
        ? [
            {
              id: "select",
              enableSorting: false,
              header: ({ table }) => {
                const count = table
                  .getCoreRowModel()
                  .rows.filter((row) => row.getIsSelected()).length
                const total = table.getCoreRowModel().rows.length
                return (
                  <Checkbox
                    aria-label="Select all"
                    checked={total > 0 && count === total}
                    indeterminate={count > 0 && count < total}
                    onCheckedChange={(value) =>
                      table.toggleAllRowsSelected(!!value)
                    }
                  />
                )
              },
              cell: ({ row }) => (
                <Checkbox
                  aria-label="Select row"
                  checked={row.getIsSelected()}
                  onCheckedChange={(value) => row.toggleSelected(!!value)}
                />
              ),
            } as ColumnDef<typeof features, TData>,
            ...columns,
          ]
        : columns,
    [columns, selectable]
  )
  const table = useTable({
    features,
    columns: allColumns,
    data,
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    initialState: {
      pagination: { pageIndex: 0, pageSize },
      rowSelection: Object.fromEntries(
        (initialSelected ?? []).map((id) => [id, true])
      ),
    },
  })
  // rows that disappeared (deleted, filtered out) are not selected any more
  const selected = selectable
    ? table.getCoreRowModel().rows.filter((row) => row.getIsSelected())
    : []
  const selectedRows = selected.map((row) => row.original)
  const clear = () => table.resetRowSelection(true)
  const onChange = React.useRef(onSelectionChange)
  React.useEffect(() => {
    onChange.current = onSelectionChange
  })
  const selectionKey = JSON.stringify(
    Object.keys(table.state.rowSelection).filter(
      (id) => table.state.rowSelection[id]
    )
  )
  React.useEffect(() => {
    onChange.current?.(JSON.parse(selectionKey))
    // reported when the set of selected rows changes
  }, [selectionKey])
  const { pageIndex } = table.state.pagination
  const pageCount = table.getPageCount()

  return (
    <div className="flex flex-col gap-2">
      {toolbar}
      {selectedRows.length > 0 && bulkActions && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 p-2 text-sm">
          <span className="px-1 font-medium">
            {selectedRows.length} selected
          </span>
          {bulkActions(selectedRows, clear)}
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
        </div>
      )}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="-ml-2.5"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <table.FlexRender header={header} />
                          {sorted === "asc" ? (
                            <ArrowUpIcon />
                          ) : sorted === "desc" ? (
                            <ArrowDownIcon />
                          ) : (
                            <ArrowUpDownIcon className="text-muted-foreground" />
                          )}
                        </Button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={allColumns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {selectable
            ? `${selectedRows.length} of ${data.length} row(s) selected`
            : `${data.length} rows`}{" "}
          · page {Math.min(pageIndex + 1, pageCount || 1)} of {pageCount || 1}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

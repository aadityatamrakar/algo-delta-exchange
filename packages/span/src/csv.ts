/** Splits CSV text into rows of trimmed cells; double quotes group a cell, blank lines are dropped. */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  for (const line of csv.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const cells: string[] = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (quoted) {
        if (c === '"') { if (line[i + 1] === '"') { cell += '"'; i++ } else quoted = false } else cell += c
      } else if (c === '"') quoted = true
      else if (c === ',') { cells.push(cell.trim()); cell = '' } else cell += c
    }
    cells.push(cell.trim())
    rows.push(cells)
  }
  return rows
}

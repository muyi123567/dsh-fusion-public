export interface PaneLayout {
  panes: string[];
  rows: Record<string, number>;
}

const STORAGE_KEY = "dsh-fusion:mission-control:panes";

export function loadPanes(): PaneLayout {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === null) return { panes: [], rows: {} };
    const parsed = JSON.parse(value) as Partial<PaneLayout>;
    if (!Array.isArray(parsed.panes) || parsed.rows === null || typeof parsed.rows !== "object") {
      return { panes: [], rows: {} };
    }

    const panes = [...new Set(parsed.panes.filter((pane): pane is string => typeof pane === "string"))];
    const parsedRows = parsed.rows as Record<string, unknown>;
    const rows: Record<string, number> = {};
    for (const pane of panes) {
      const row = parsedRows[pane];
      rows[pane] = typeof row === "number" && Number.isInteger(row) && row >= 0 ? row : 0;
    }
    return { panes, rows };
  } catch {
    return { panes: [], rows: {} };
  }
}

export function persistPanes(panes: string[], rows: Record<string, number>): PaneLayout {
  const uniquePanes = [...new Set(panes)];
  const nextRows: Record<string, number> = {};
  uniquePanes.forEach((pane, index) => {
    const row = rows[pane];
    nextRows[pane] = typeof row === "number" && Number.isInteger(row) && row >= 0
      ? row
      : Math.floor(index / 2);
  });
  const layout = { panes: uniquePanes, rows: nextRows };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  return layout;
}

export function addPane(layout: PaneLayout, paneId: string, row?: number): PaneLayout {
  if (layout.panes.includes(paneId)) {
    return layout;
  }
  const nextRow = row ?? Math.floor(layout.panes.length / 2);
  return persistPanes(
    [...layout.panes, paneId],
    { ...layout.rows, [paneId]: nextRow },
  );
}

export function removePane(layout: PaneLayout, paneId: string): PaneLayout {
  const rows = { ...layout.rows };
  delete rows[paneId];
  return persistPanes(layout.panes.filter((id) => id !== paneId), rows);
}

export function setPaneRow(layout: PaneLayout, paneId: string, row: number): PaneLayout {
  return persistPanes(layout.panes, {
    ...layout.rows,
    [paneId]: Math.max(0, row),
  });
}

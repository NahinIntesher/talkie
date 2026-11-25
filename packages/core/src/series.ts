/** Day-by-day counts for the admin dashboard: fills days with no rows with 0. `rows.day` is `YYYY-MM-DD` (UTC). */
export function dailySeries(rows: Array<{ day: string; total: string | number }>, days: number, now = new Date()): Array<{ day: string; total: number }> {
  const byDay = new Map(rows.map((row) => [row.day, Number(row.total)]));
  const out: Array<{ day: string; total: number }> = [];
  for (let index = days - 1; index >= 0; index--) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - index)).toISOString().slice(0, 10);
    out.push({ day, total: byDay.get(day) ?? 0 });
  }
  return out;
}

/** Midnight UTC `days - 1` days ago: the start of a `days`-long series ending today. */
export const seriesStart = (days: number, now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));

/** Escapes `%`, `_` and `\` for a LIKE pattern. */
export const likeEscape = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

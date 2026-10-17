import { checkedFetch } from '../api/client';

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads an authenticated API file (e.g. an import template), named as the server suggests unless given a name. */
export async function downloadFromApi(path: string, filename?: string) {
  const res = await checkedFetch(path);
  const suggested = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  saveBlob(await res.blob(), filename ?? suggested ?? 'download');
}

/** Saves rows as a CSV that Excel opens correctly (UTF-8 BOM, quoted cells). */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Leading = + - @ would be run as formulas by spreadsheet apps.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  saveBlob(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }), filename);
}

/**
 * HTML ユーティリティ - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * サーバサイドで文字列 HTML を組み立てるための最小限のヘルパ。
 * XSS を防ぐため、動画タイトル・要約など外部由来の文字列は必ず esc() を通す。
 */

/** HTML 特殊文字をエスケープする（属性値・本文の両方に安全な最小集合）。 */
export function esc(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** ISO 文字列を「YYYY-MM-DD HH:mm」表記（ローカル非依存の UTC）にする。 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())} UTC`;
}

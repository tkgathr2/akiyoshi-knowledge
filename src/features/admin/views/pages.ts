/**
 * ページテンプレート - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * 各画面（ログイン / ダッシュボード / 設定 / デバッグ）の HTML を組み立てる純粋関数群。
 * 副作用を持たず入力から HTML 文字列を返すだけにして、単体テストで内容を検証できるようにする。
 */

import { AdminConfig, CONFIG_LIMITS, CycleRecord, StatusView, VideoView } from '../types/admin';
import { esc, fmtDateTime } from './html';
import { STYLES } from './styles';

type NavKey = 'dashboard' | 'settings' | 'debug';

/** 全画面共通の外枠（ヘッダ・ナビ・スタイル）。 */
function layout(title: string, active: NavKey, body: string): string {
  const nav = (key: NavKey, href: string, label: string): string =>
    `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 秋好ナレッジ取込</title>
<style>${STYLES}</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><span class="dot"></span>秋好ナレッジ YouTube 取込</div>
  <nav class="main">
    ${nav('dashboard', '/', 'ダッシュボード')}
    ${nav('settings', '/settings', '設定')}
    ${nav('debug', '/debug', 'デバッグ')}
    <a href="/logout">ログアウト</a>
  </nav>
</div>
<div class="wrap">
${body}
</div>
<div class="foot">秋好ナレッジ YouTube 取込システム · 管理画面</div>
</body>
</html>`;
}

/** ログイン画面。error があれば赤帯を出す。 */
export function loginPage(opts: { error?: string; redirectTo?: string } = {}): string {
  const err = opts.error ? `<div class="alert err">${esc(opts.error)}</div>` : '';
  const redirect = opts.redirectTo ? esc(opts.redirectTo) : '/';
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログイン · 秋好ナレッジ取込</title>
<style>${STYLES}</style>
</head>
<body>
<div class="login-wrap">
  <div class="login-card">
    <h1>管理画面ログイン</h1>
    <p class="sub">秋好ナレッジ YouTube 取込システム</p>
    ${err}
    <form method="post" action="/login">
      <input type="hidden" name="redirectTo" value="${redirect}">
      <div class="field">
        <label for="password">管理者パスワード</label>
        <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
      </div>
      <button class="btn" type="submit">ログイン</button>
    </form>
  </div>
</div>
</body>
</html>`;
}

/** ダッシュボード（ステータス + 動画一覧）。 */
export function dashboardPage(opts: {
  status: StatusView;
  videos: VideoView[];
  config: AdminConfig;
  videoError?: string;
}): string {
  const { status, videos, config, videoError } = opts;

  const healthBadge = status.lastRunAt
    ? status.healthy
      ? '<span class="badge ok">正常</span>'
      : '<span class="badge err">エラー</span>'
    : '<span class="badge warn">未実行</span>';

  const cards = `
  <div class="grid">
    <div class="card"><div class="label">最終取込時刻</div><div class="value" style="font-size:16px">${esc(
      fmtDateTime(status.lastRunAt)
    )}</div></div>
    <div class="card"><div class="label">新規動画数</div><div class="value">${status.lastNewVideos}<span class="unit"> 件</span></div></div>
    <div class="card"><div class="label">エラー件数</div><div class="value">${status.lastErrorCount}<span class="unit"> 件</span></div></div>
    <div class="card"><div class="label">次回実行予定</div><div class="value" style="font-size:16px">${esc(
      fmtDateTime(status.nextRunAt)
    )}</div></div>
  </div>`;

  const videoBody = videoError
    ? `<div class="alert err">動画一覧を取得できませんでした: ${esc(videoError)}</div>`
    : videos.length === 0
      ? '<div class="empty">取込済みの動画がまだありません。</div>'
      : `<ul class="videolist">${videos
          .map(
            (v) => `<li>
        <div class="vtitle">${esc(v.title)}</div>
        <div class="vmeta">${esc(fmtDateTime(v.createdAt))}${
          v.sourceUrl ? ` · <a href="${esc(v.sourceUrl)}" target="_blank" rel="noopener">YouTube</a>` : ''
        }</div>
        <div class="vsummary">${esc(v.summary)}</div>
      </li>`
          )
          .join('')}</ul>`;

  const body = `
  <h1>ダッシュボード ${healthBadge}</h1>
  <p class="sub">チャンネル: <span class="mono">${
    config.channelId ? esc(config.channelId) : '未設定'
  }</span> · 巡回間隔: ${config.pollIntervalMinutes} 分 · キーポイント数: ${config.keyPointCount}</p>
  <div class="panel">
    <h2>取込ステータス</h2>
    ${cards}
  </div>
  <div class="panel">
    <h2>取込済み動画（Notion）</h2>
    ${videoBody}
  </div>`;

  return layout('ダッシュボード', 'dashboard', body);
}

/** 設定ページ。保存結果（成功/エラー）を帯で表示する。 */
export function settingsPage(opts: {
  config: AdminConfig;
  errors?: string[];
  saved?: boolean;
}): string {
  const { config, errors, saved } = opts;

  const alert =
    errors && errors.length > 0
      ? `<div class="alert err">${errors.map((e) => esc(e)).join('<br>')}</div>`
      : saved
        ? '<div class="alert ok">設定を保存しました。</div>'
        : '';

  const { pollIntervalMinutes: pl, keyPointCount: kl } = CONFIG_LIMITS;

  const body = `
  <h1>設定</h1>
  <p class="sub">取込の対象チャンネルと動作パラメータを編集します。保存後、次回サイクルから反映されます。</p>
  <div class="panel">
    ${alert}
    <form method="post" action="/settings">
      <div class="field">
        <label for="channelId">チャンネル ID
          <span class="hint">UC で始まる 24 文字。空にすると取込を無効化します。</span>
        </label>
        <input type="text" id="channelId" name="channelId" value="${esc(
          config.channelId
        )}" placeholder="UCxxxxxxxxxxxxxxxxxxxxxx" pattern="(UC[\\w-]{22})?">
      </div>
      <div class="field">
        <label for="pollIntervalMinutes">ポーリング間隔（分）
          <span class="hint">${pl.min}〜${pl.max}。次回実行予定の算出に使います。</span>
        </label>
        <input type="number" id="pollIntervalMinutes" name="pollIntervalMinutes" min="${
          pl.min
        }" max="${pl.max}" step="1" value="${esc(config.pollIntervalMinutes)}" required>
      </div>
      <div class="field">
        <label for="keyPointCount">キーポイント数
          <span class="hint">${kl.min}〜${kl.max}。1 動画から抽出する要点の数。</span>
        </label>
        <input type="number" id="keyPointCount" name="keyPointCount" min="${kl.min}" max="${
          kl.max
        }" step="1" value="${esc(config.keyPointCount)}" required>
      </div>
      <button class="btn" type="submit">保存する</button>
    </form>
  </div>
  <p class="sub">最終更新: ${esc(fmtDateTime(config.updatedAt))}</p>`;

  return layout('設定', 'settings', body);
}

/** デバッグ画面（直近サイクルのログ + 再実行ボタン）。 */
export function debugPage(opts: {
  records: CycleRecord[];
  rerunResult?: { ok: boolean; message: string };
}): string {
  const { records, rerunResult } = opts;

  const alert = rerunResult
    ? `<div class="alert ${rerunResult.ok ? 'ok' : 'err'}">${esc(rerunResult.message)}</div>`
    : '';

  const logs =
    records.length === 0
      ? '<div class="empty">まだ取込サイクルの記録がありません。</div>'
      : records
          .map((r) => {
            const errCount = (r.error ? 1 : 0) + r.skipped.length;
            const badge = r.error
              ? '<span class="badge err">失敗</span>'
              : errCount > 0
                ? '<span class="badge warn">一部スキップ</span>'
                : '<span class="badge ok">成功</span>';
            const trig = r.trigger === 'manual' ? '手動' : '定期';
            const skipList =
              r.skipped.length > 0
                ? `<div class="skip">スキップ ${r.skipped.length} 件: ${r.skipped
                    .map((s) => `${esc(s.videoId)}（${esc(s.reason)}）`)
                    .join(' / ')}</div>`
                : '';
            const errLine = r.error
              ? `<div class="skip" style="color:var(--err)">エラー: ${esc(r.error)}</div>`
              : '';
            return `<div class="logline">
        <div class="row">
          <strong>${esc(fmtDateTime(r.finishedAt))}</strong>
          <span>${badge} <span class="mono">${trig}</span></span>
        </div>
        <div class="row">
          <span>取得 ${r.fetched} · 新規 ${r.newVideos} · 書込 ${r.written} · エラー ${errCount}</span>
        </div>
        ${skipList}
        ${errLine}
      </div>`;
          })
          .join('');

  const body = `
  <h1>デバッグ</h1>
  <p class="sub">直近 5 サイクルの実行ログと、取込の手動再実行。</p>
  <div class="panel">
    <h2>手動再実行</h2>
    <p class="sub">いま取込を 1 サイクル実行します（新着 → 字幕 → Notion 保存）。完了まで数十秒かかることがあります。</p>
    ${alert}
    <form method="post" action="/debug/rerun">
      <button class="btn" type="submit">取込を今すぐ実行</button>
    </form>
  </div>
  <div class="panel">
    <h2>直近サイクルのログ</h2>
    ${logs}
  </div>`;

  return layout('デバッグ', 'debug', body);
}

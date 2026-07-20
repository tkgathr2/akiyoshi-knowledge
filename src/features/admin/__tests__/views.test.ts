/**
 * 単体: ビュー（html ヘルパ + ページテンプレート）
 * 重点は XSS エスケープ（外部由来の動画タイトル・要約が生 HTML にならないこと）。
 */
import { esc, fmtDateTime } from '../views/html';
import { dashboardPage, settingsPage, debugPage, loginPage } from '../views/pages';
import { AdminConfig, CycleRecord, StatusView, VideoView } from '../types/admin';

describe('esc', () => {
  it('HTML 特殊文字をエスケープする', () => {
    expect(esc('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;');
  });
  it('null / undefined は空文字', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('fmtDateTime', () => {
  it('ISO を UTC 表記へ整形する', () => {
    expect(fmtDateTime('2026-07-20T09:05:00.000Z')).toBe('2026-07-20 09:05 UTC');
  });
  it('null / 不正値はダッシュ', () => {
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDateTime('nope')).toBe('—');
  });
});

const status: StatusView = {
  lastRunAt: '2026-07-20T00:05:00.000Z',
  lastNewVideos: 2,
  lastWritten: 2,
  lastErrorCount: 1,
  nextRunAt: '2026-07-20T01:05:00.000Z',
  healthy: true,
};
const config: AdminConfig = { channelId: 'UCabcdefghijklmnopqrstuv', pollIntervalMinutes: 60, keyPointCount: 7 };

describe('dashboardPage', () => {
  it('4 つのステータス指標を描画する', () => {
    const html = dashboardPage({ status, videos: [], config });
    expect(html).toContain('最終取込時刻');
    expect(html).toContain('新規動画数');
    expect(html).toContain('エラー件数');
    expect(html).toContain('次回実行予定');
  });

  it('動画タイトル/要約の XSS を必ずエスケープする', () => {
    const videos: VideoView[] = [
      {
        id: 'x',
        title: '<img src=x onerror=alert(1)>',
        summary: '<b>evil</b>',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    ];
    const html = dashboardPage({ status, videos, config });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<b>evil</b>');
  });

  it('動画一覧の取得失敗はステータスを保ったままエラー帯を出す', () => {
    const html = dashboardPage({ status, videos: [], config, videoError: 'Notion 500' });
    expect(html).toContain('動画一覧を取得できませんでした');
    expect(html).toContain('取込ステータス'); // ステータスは出続ける
  });

  it('動画ゼロ件は空表示', () => {
    const html = dashboardPage({ status, videos: [], config });
    expect(html).toContain('取込済みの動画がまだありません');
  });
});

describe('settingsPage', () => {
  it('現在値を入力欄の value に載せる', () => {
    const html = settingsPage({ config });
    expect(html).toContain('value="UCabcdefghijklmnopqrstuv"');
    expect(html).toContain('value="60"');
    expect(html).toContain('value="7"');
  });
  it('保存成功で成功帯、エラーでエラー帯', () => {
    expect(settingsPage({ config, saved: true })).toContain('設定を保存しました');
    expect(settingsPage({ config, errors: ['だめ'] })).toContain('だめ');
  });
});

describe('debugPage', () => {
  const rec: CycleRecord = {
    startedAt: '2026-07-20T00:00:00.000Z',
    finishedAt: '2026-07-20T00:05:00.000Z',
    fetched: 3,
    newVideos: 1,
    written: 1,
    skipped: [{ videoId: 'v1', reason: '字幕なし' }],
    trigger: 'manual',
  };
  it('サイクルログと再実行ボタンを描画する', () => {
    const html = debugPage({ records: [rec] });
    expect(html).toContain('直近サイクルのログ');
    expect(html).toContain('取込を今すぐ実行');
    expect(html).toContain('字幕なし');
    expect(html).toContain('手動');
  });
  it('再実行結果の帯を出す', () => {
    expect(debugPage({ records: [], rerunResult: { ok: true, message: 'done' } })).toContain('done');
  });
  it('履歴ゼロ件は空表示', () => {
    expect(debugPage({ records: [] })).toContain('まだ取込サイクルの記録がありません');
  });
});

describe('loginPage', () => {
  it('redirectTo を hidden で保持し、エラー帯を出せる', () => {
    const html = loginPage({ error: 'パスワードが違います。', redirectTo: '/settings' });
    expect(html).toContain('パスワードが違います');
    expect(html).toContain('value="/settings"');
  });
});

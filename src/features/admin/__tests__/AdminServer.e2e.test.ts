/**
 * E2E: 管理画面の一連フロー - 秋好ナレッジ YouTube 取込システム
 *
 * 実際に AdminServer を http でエフェメラルポートに listen し、生の HTTP リクエストで
 * 「未ログイン → ログイン → 設定変更 → ステータス確認 → デバッグ再実行」を通しで検証する。
 * ストア類は本物（tmp ディレクトリの JSON ファイル）を使い、外部 I/O（Notion / YouTube）だけ
 * スタブに差し替える。これにより「本当にサーバとして動くか」を仕様として固定する。
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Server } from 'http';
import http from 'http';
import pino from 'pino';

import { AdminConfigStore } from '../config/AdminConfigStore';
import { CycleHistoryStore } from '../history/CycleHistoryStore';
import { StatusService } from '../status/StatusService';
import { SessionManager } from '../auth/SessionManager';
import { AdminServer } from '../server/AdminServer';
import { CycleRecord, StatusView, VideoView } from '../types/admin';

const silent = pino({ level: 'silent' });
const PASSWORD = 'test-pass-1234';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** ライブラリを足さず Node 標準だけで 1 リクエスト投げる小さなクライアント。 */
function request(
  port: number,
  method: string,
  reqPath: string,
  opts: { cookie?: string; form?: Record<string, string> } = {}
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.form
      ? new URLSearchParams(opts.form).toString()
      : undefined;
    const headers: Record<string, string> = {};
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

/** Set-Cookie ヘッダから本セッションの `name=value` を取り出す。 */
function cookieFrom(res: Res): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error('Set-Cookie が返っていません');
  return first.split(';')[0];
}

describe('AdminServer E2E: 未ログイン→ログイン→設定変更→ステータス確認', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let historyStore: CycleHistoryStore;

  // reingest スタブ: 呼ばれたら成功サイクルを 1 件履歴へ積んで返す（Notion/YouTube に触れない）。
  const stubVideos: VideoView[] = [
    {
      id: 'page-1',
      title: 'テスト動画タイトル',
      summary: 'これはキーポイント要約のプレビューです。',
      sourceUrl: 'https://www.youtube.com/watch?v=abc',
      createdAt: '2026-07-20T00:00:00.000Z',
    },
  ];

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'akiyoshi-admin-e2e-'));
    const configStore = new AdminConfigStore(path.join(dir, 'config.json'), silent);
    historyStore = new CycleHistoryStore(path.join(dir, 'history.json'), 50, silent);
    const statusService = new StatusService(historyStore, configStore);
    const sessionManager = new SessionManager({ password: PASSWORD, secret: 'e2e-secret' });

    const reingest = async (): Promise<CycleRecord> => {
      const now = new Date().toISOString();
      const record: CycleRecord = {
        startedAt: now,
        finishedAt: now,
        fetched: 3,
        newVideos: 1,
        written: 1,
        skipped: [{ videoId: 'novtt', reason: '字幕なし' }],
        trigger: 'manual',
      };
      await historyStore.append(record);
      return record;
    };

    const admin = new AdminServer({
      configStore,
      historyStore,
      statusService,
      sessionManager,
      videoLister: { listVideos: async () => stubVideos },
      reingest,
      logger: silent,
    });

    server = await admin.listen(0); // 0 = OS がエフェメラルポートを割り当てる
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('未ログインでダッシュボードを開くと /login へ 302 リダイレクトする', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?redirectTo=/);
  });

  it('未ログインの API は 401 を返す', async () => {
    const res = await request(port, 'GET', '/api/status');
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
  });

  it('誤ったパスワードでは 401 でログインできない', async () => {
    const res = await request(port, 'POST', '/login', { form: { password: 'wrong', redirectTo: '/' } });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('パスワードが違います');
  });

  it('正しいパスワードでログインするとセッション Cookie が発行され、以降ダッシュボードが開ける', async () => {
    const login = await request(port, 'POST', '/login', {
      form: { password: PASSWORD, redirectTo: '/' },
    });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/');
    const cookie = cookieFrom(login);
    expect(cookie).toContain('akiyoshi_admin_session=');

    // ログイン後はダッシュボードが 200 で開き、スタブ動画一覧が描画される。
    const dash = await request(port, 'GET', '/', { cookie });
    expect(dash.status).toBe(200);
    expect(dash.body).toContain('ダッシュボード');
    expect(dash.body).toContain('テスト動画タイトル');
    expect(dash.body).toContain('取込ステータス');
  });

  it('設定を変更して保存すると永続化され、次回表示・ステータス算出に反映される', async () => {
    // ログインして Cookie を得る
    const login = await request(port, 'POST', '/login', {
      form: { password: PASSWORD, redirectTo: '/' },
    });
    const cookie = cookieFrom(login);

    // 設定変更（チャンネル ID / ポーリング間隔 / キーポイント数）
    const save = await request(port, 'POST', '/settings', {
      cookie,
      form: {
        channelId: 'UCabcdefghijklmnopqrstuv',
        pollIntervalMinutes: '120',
        keyPointCount: '8',
      },
    });
    expect(save.status).toBe(200);
    expect(save.body).toContain('設定を保存しました');

    // 再表示で保存値が入力欄に載っている（永続化の確認）
    const reopen = await request(port, 'GET', '/settings', { cookie });
    expect(reopen.body).toContain('value="UCabcdefghijklmnopqrstuv"');
    expect(reopen.body).toContain('value="120"');
    expect(reopen.body).toContain('value="8"');

    // ダッシュボードのサマリにも新しい設定が出る
    const dash = await request(port, 'GET', '/', { cookie });
    expect(dash.body).toContain('UCabcdefghijklmnopqrstuv');
    expect(dash.body).toContain('120 分');
  });

  it('不正な設定値は 400 で弾かれ、保存されない', async () => {
    const login = await request(port, 'POST', '/login', {
      form: { password: PASSWORD, redirectTo: '/' },
    });
    const cookie = cookieFrom(login);

    const bad = await request(port, 'POST', '/settings', {
      cookie,
      form: { channelId: 'not-a-channel', pollIntervalMinutes: '5', keyPointCount: '99' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toContain('チャンネル ID は UC');
    expect(bad.body).toMatch(/キーポイント数は 5〜10/);
  });

  it('デバッグ画面から手動再実行するとサイクルが記録され、ステータス API に反映される', async () => {
    const login = await request(port, 'POST', '/login', {
      form: { password: PASSWORD, redirectTo: '/' },
    });
    const cookie = cookieFrom(login);

    // 再実行前: 履歴は空（このテスト群で初めて append する）
    const before = await request(port, 'GET', '/api/status', { cookie });
    const beforeStatus = JSON.parse(before.body) as StatusView;
    expect(beforeStatus.lastRunAt).toBeNull();

    // 手動再実行
    const rerun = await request(port, 'POST', '/debug/rerun', { cookie });
    expect(rerun.status).toBe(200);
    expect(rerun.body).toContain('再実行完了');

    // 再実行後: ステータス API が直近サイクルを反映する
    const after = await request(port, 'GET', '/api/status', { cookie });
    const afterStatus = JSON.parse(after.body) as StatusView;
    expect(afterStatus.lastRunAt).not.toBeNull();
    expect(afterStatus.lastNewVideos).toBe(1);
    expect(afterStatus.lastErrorCount).toBe(1); // スキップ 1 件
    expect(afterStatus.nextRunAt).not.toBeNull(); // 設定の pollInterval から算出される

    // デバッグ画面にもログ行が出る
    const debug = await request(port, 'GET', '/debug', { cookie });
    expect(debug.body).toContain('直近サイクルのログ');
    expect(debug.body).toContain('手動');
  });

  it('ヘルスチェックは認証不要で 200 を返す', async () => {
    const res = await request(port, 'GET', '/healthz');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('ログアウトすると Cookie が失効し、保護ページは再びログインへ回される', async () => {
    const login = await request(port, 'POST', '/login', {
      form: { password: PASSWORD, redirectTo: '/' },
    });
    const cookie = cookieFrom(login);

    const logout = await request(port, 'GET', '/logout', { cookie });
    expect(logout.status).toBe(302);
    expect(logout.headers.location).toBe('/login');
    const cleared = cookieFrom(logout);
    // 失効 Cookie（空値）で保護ページへ行くと 302 でログインへ
    const dash = await request(port, 'GET', '/', { cookie: cleared });
    expect(dash.status).toBe(302);
    expect(dash.headers.location).toMatch(/^\/login/);
  });
});

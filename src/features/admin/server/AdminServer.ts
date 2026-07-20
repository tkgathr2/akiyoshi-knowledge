/**
 * 管理サーバ - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * Node 標準の http モジュールだけで動く自己完結サーバ（外部 Web フレームワーク無し）。
 * 依存はすべてコンストラクタで注入し、E2E テストからスタブへ差し替えられるようにする。
 *
 * 画面: ログイン / ダッシュボード（ステータス+動画一覧）/ 設定 / デバッグ（ログ+再実行）。
 * 認証: SessionManager による Cookie セッション。未ログインは /login へリダイレクトする。
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import pino from 'pino';

import { AdminConfigStore } from '../config/AdminConfigStore';
import { CycleHistoryStore } from '../history/CycleHistoryStore';
import { StatusService } from '../status/StatusService';
import { SessionManager } from '../auth/SessionManager';
import { VideoLister, CycleRecord } from '../types/admin';
import { dashboardPage, debugPage, loginPage, settingsPage } from '../views/pages';

/** デバッグ画面に出す直近サイクル件数 */
const RECENT_CYCLES = 5;
/** ダッシュボードの動画一覧に出す件数 */
const VIDEO_LIST_LIMIT = 15;
/** リクエストボディの上限（DoS 防止・フォーム用途には十分） */
const MAX_BODY_BYTES = 64 * 1024;

export interface AdminServerDeps {
  configStore: AdminConfigStore;
  historyStore: CycleHistoryStore;
  statusService: StatusService;
  sessionManager: SessionManager;
  videoLister: VideoLister;
  /**
   * 取込を 1 サイクル手動実行する。デバッグ画面の「今すぐ実行」から呼ばれる。
   * 呼び出し先が実行 → 履歴への追記まで行い、記録した CycleRecord を返す契約。
   * （定期実行と手動実行で履歴追記の経路を 1 本化するため、追記は本コールバック側の責務）
   */
  reingest: () => Promise<CycleRecord>;
  logger?: pino.Logger;
}

export class AdminServer {
  private readonly logger: pino.Logger;

  constructor(private readonly deps: AdminServerDeps) {
    this.logger = deps.logger || pino({ name: 'AdminServer' });
  }

  /** http.Server を生成する（listen は呼び出し側で行う）。 */
  createHttpServer(): Server {
    return createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.logger.error({ error, url: req.url }, 'Unhandled admin request error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('Internal Server Error');
      });
    });
  }

  /** 指定ポートで listen する簡易ヘルパ。 */
  listen(port: number): Promise<Server> {
    const server = this.createHttpServer();
    return new Promise((resolve) => {
      server.listen(port, () => {
        const addr = server.address();
        const actual = typeof addr === 'object' && addr ? addr.port : port;
        this.logger.info({ port: actual }, 'Admin server listening');
        resolve(server);
      });
    });
  }

  /** ルーティングの中枢。 */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    // ヘルスチェックは認証不要（Railway / 監視から叩けるように）。
    if (method === 'GET' && path === '/healthz') {
      return this.sendJson(res, 200, { ok: true });
    }

    // --- 認証不要ルート ---
    if (path === '/login') {
      if (method === 'GET') return this.getLogin(url, res);
      if (method === 'POST') return this.postLogin(req, res);
      return this.methodNotAllowed(res);
    }

    if (path === '/logout' && (method === 'GET' || method === 'POST')) {
      return this.logout(res);
    }

    // --- ここから認証必須 ---
    if (!this.isAuthed(req)) {
      // API は 401 JSON、画面はログインへ 302。
      if (path.startsWith('/api/')) return this.sendJson(res, 401, { error: 'unauthorized' });
      const redirectTo = encodeURIComponent(path + url.search);
      return this.redirect(res, `/login?redirectTo=${redirectTo}`);
    }

    if (method === 'GET' && path === '/') return this.getDashboard(res);
    if (path === '/settings') {
      if (method === 'GET') return this.getSettings(res, {});
      if (method === 'POST') return this.postSettings(req, res);
      return this.methodNotAllowed(res);
    }
    if (path === '/debug') {
      if (method === 'GET') return this.getDebug(res, {});
      return this.methodNotAllowed(res);
    }
    if (method === 'POST' && path === '/debug/rerun') return this.postRerun(res);
    if (method === 'GET' && path === '/api/status') {
      const status = await this.deps.statusService.getStatus();
      return this.sendJson(res, 200, status);
    }

    return this.notFound(res);
  }

  // ---------- ルートハンドラ ----------

  private getLogin(url: URL, res: ServerResponse): void {
    const redirectTo = url.searchParams.get('redirectTo') || '/';
    this.sendHtml(res, 200, loginPage({ redirectTo }));
  }

  private async postLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await this.readForm(req);
    const password = form.get('password') || '';
    const redirectTo = safeRedirect(form.get('redirectTo'));

    if (!this.deps.sessionManager.verifyPassword(password)) {
      this.logger.warn('Failed admin login attempt');
      return this.sendHtml(
        res,
        401,
        loginPage({ error: 'パスワードが違います。', redirectTo })
      );
    }

    const token = this.deps.sessionManager.issueToken();
    res.setHeader('Set-Cookie', this.deps.sessionManager.buildSetCookie(token));
    this.redirect(res, redirectTo);
  }

  private logout(res: ServerResponse): void {
    res.setHeader('Set-Cookie', this.deps.sessionManager.buildClearCookie());
    this.redirect(res, '/login');
  }

  private async getDashboard(res: ServerResponse): Promise<void> {
    const [status, config] = await Promise.all([
      this.deps.statusService.getStatus(),
      this.deps.configStore.load(),
    ]);

    // 動画一覧の取得失敗はダッシュボード全体を落とさない（ステータスは出す）。
    let videos = [] as Awaited<ReturnType<VideoLister['listVideos']>>;
    let videoError: string | undefined;
    try {
      videos = await this.deps.videoLister.listVideos(VIDEO_LIST_LIMIT);
    } catch (error) {
      videoError = error instanceof Error ? error.message : String(error);
      this.logger.error({ error }, 'Failed to list videos for dashboard');
    }

    this.sendHtml(res, 200, dashboardPage({ status, videos, config, videoError }));
  }

  private async getSettings(
    res: ServerResponse,
    extra: { errors?: string[]; saved?: boolean }
  ): Promise<void> {
    const config = await this.deps.configStore.load();
    this.sendHtml(res, 200, settingsPage({ config, ...extra }));
  }

  private async postSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await this.readForm(req);
    const result = await this.deps.configStore.save({
      channelId: form.get('channelId') ?? '',
      pollIntervalMinutes: Number(form.get('pollIntervalMinutes')),
      keyPointCount: Number(form.get('keyPointCount')),
    });

    if (!result.valid) {
      // 入力値を保ったまま再表示するため、検証済み value をそのまま描画に使う。
      return this.sendHtml(
        res,
        400,
        settingsPage({ config: result.value, errors: result.errors })
      );
    }
    this.sendHtml(res, 200, settingsPage({ config: result.value, saved: true }));
  }

  private async getDebug(
    res: ServerResponse,
    extra: { rerunResult?: { ok: boolean; message: string } }
  ): Promise<void> {
    const records = await this.deps.historyStore.list(RECENT_CYCLES);
    this.sendHtml(res, 200, debugPage({ records, ...extra }));
  }

  private async postRerun(res: ServerResponse): Promise<void> {
    try {
      const record = await this.deps.reingest();
      const errCount = (record.error ? 1 : 0) + record.skipped.length;
      const message = record.error
        ? `再実行しましたが失敗しました: ${record.error}`
        : `再実行完了: 取得 ${record.fetched} / 新規 ${record.newVideos} / 書込 ${record.written} / エラー ${errCount}`;
      return this.getDebug(res, { rerunResult: { ok: !record.error, message } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.getDebug(res, { rerunResult: { ok: false, message: `再実行に失敗: ${message}` } });
    }
  }

  // ---------- 補助 ----------

  private isAuthed(req: IncomingMessage): boolean {
    const token = SessionManager.readCookie(req.headers.cookie);
    return this.deps.sessionManager.verifyToken(token);
  }

  /** application/x-www-form-urlencoded ボディを読み取り Map で返す。 */
  private readForm(req: IncomingMessage): Promise<Map<string, string>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const params = new URLSearchParams(body);
        const map = new Map<string, string>();
        for (const [k, v] of params) map.set(k, v);
        resolve(map);
      });
      req.on('error', reject);
    });
  }

  private sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    res.end(html);
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { Location: location });
    res.end();
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  private methodNotAllowed(res: ServerResponse): void {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  }
}

/**
 * オープンリダイレクト対策: リダイレクト先はアプリ内パス（/ 始まり・// でない）だけ許可する。
 */
function safeRedirect(value: string | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

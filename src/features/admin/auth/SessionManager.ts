/**
 * セッション管理 - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * 管理画面は単一の管理者パスワード（環境変数 ADMIN_PASSWORD）で保護する。
 * ログイン成功時に HMAC 署名付きトークンを Cookie に発行し、以降のリクエストで
 * 署名と有効期限を検証する。外部セッションストア（Redis 等）を持たない自己完結方式。
 *
 * 署名鍵は ADMIN_SESSION_SECRET を使う。未設定なら ADMIN_PASSWORD から鍵導出する
 * （運用開始の手間を減らすため）。トークン本体は署名で改ざんを防ぐため平文でよい。
 *
 * セキュリティ上の注意:
 *   - パスワード照合は timingSafeEqual で長さ非依存の定数時間比較にする。
 *   - Cookie は HttpOnly / SameSite=Lax。HTTPS 環境では Secure も付与する。
 */

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

/** セッション Cookie 名 */
export const SESSION_COOKIE = 'akiyoshi_admin_session';

export interface SessionOptions {
  /** 管理者パスワード（必須） */
  password: string;
  /** 署名鍵（未指定なら password から導出） */
  secret?: string;
  /** セッション有効期間（ミリ秒・既定 12 時間） */
  ttlMs?: number;
  /** Secure 属性を付けるか（HTTPS 配信時 true） */
  secure?: boolean;
}

export class SessionManager {
  private readonly password: string;
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly secure: boolean;

  constructor(options: SessionOptions) {
    if (!options.password) {
      throw new Error('ADMIN_PASSWORD が未設定です（管理画面のログインに必須）');
    }
    this.password = options.password;
    this.secret = options.secret || `derived:${options.password}`;
    this.ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
    this.secure = options.secure ?? false;
  }

  /**
   * パスワードを定数時間で照合する。
   * 長さが異なると timingSafeEqual が例外を投げるため、HMAC を挟んで長さを揃える。
   */
  verifyPassword(input: string): boolean {
    const a = createHmac('sha256', this.secret).update(input ?? '').digest();
    const b = createHmac('sha256', this.secret).update(this.password).digest();
    return timingSafeEqual(a, b);
  }

  /**
   * 新しいセッショントークンを発行する。
   * 形式: base64url(payload).hmac  payload = { exp, nonce }
   */
  issueToken(now = Date.now()): string {
    const payload = JSON.stringify({ exp: now + this.ttlMs, nonce: randomBytes(8).toString('hex') });
    const body = Buffer.from(payload, 'utf-8').toString('base64url');
    const sig = this.sign(body);
    return `${body}.${sig}`;
  }

  /**
   * トークンを検証する。署名不一致・期限切れ・形式不正はすべて false。
   */
  verifyToken(token: string | undefined, now = Date.now()): boolean {
    if (!token || typeof token !== 'string') return false;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return false;

    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = this.sign(body);
    if (!SessionManager.safeEqualStr(sig, expected)) return false;

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
      return typeof payload.exp === 'number' && payload.exp > now;
    } catch {
      return false;
    }
  }

  /** ログイン成功時に発行する Set-Cookie ヘッダ値。 */
  buildSetCookie(token: string): string {
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.ttlMs / 1000)}`,
    ];
    if (this.secure) parts.push('Secure');
    return parts.join('; ');
  }

  /** ログアウト時に Cookie を失効させる Set-Cookie ヘッダ値。 */
  buildClearCookie(): string {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (this.secure) parts.push('Secure');
    return parts.join('; ');
  }

  /** Cookie ヘッダ文字列から本セッショントークンを取り出す。 */
  static readCookie(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined;
    for (const pair of cookieHeader.split(';')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      if (name === SESSION_COOKIE) return pair.slice(idx + 1).trim();
    }
    return undefined;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  /** 文字列の定数時間比較（長さ差でも例外を出さない）。 */
  private static safeEqualStr(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }
}

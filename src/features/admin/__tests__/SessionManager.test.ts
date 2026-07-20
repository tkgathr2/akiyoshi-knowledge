/**
 * 単体: SessionManager - パスワード照合 / トークン発行・検証 / Cookie
 */
import { SessionManager, SESSION_COOKIE } from '../auth/SessionManager';

const opts = { password: 'hunter2', secret: 'unit-secret' };

describe('SessionManager', () => {
  it('password 未設定なら生成時に例外を投げる', () => {
    expect(() => new SessionManager({ password: '' })).toThrow();
  });

  it('正しいパスワードのみ照合を通す', () => {
    const sm = new SessionManager(opts);
    expect(sm.verifyPassword('hunter2')).toBe(true);
    expect(sm.verifyPassword('wrong')).toBe(false);
    expect(sm.verifyPassword('')).toBe(false);
  });

  it('発行したトークンは検証を通る', () => {
    const sm = new SessionManager(opts);
    const token = sm.issueToken();
    expect(sm.verifyToken(token)).toBe(true);
  });

  it('署名を改ざんしたトークンは弾く', () => {
    const sm = new SessionManager(opts);
    const token = sm.issueToken();
    const tampered = token.slice(0, -3) + 'zzz';
    expect(sm.verifyToken(tampered)).toBe(false);
  });

  it('別の secret で署名されたトークンは弾く', () => {
    const a = new SessionManager({ password: 'p', secret: 'A' });
    const b = new SessionManager({ password: 'p', secret: 'B' });
    expect(b.verifyToken(a.issueToken())).toBe(false);
  });

  it('期限切れトークンは弾く', () => {
    const sm = new SessionManager({ ...opts, ttlMs: 1000 });
    const now = 1_000_000;
    const token = sm.issueToken(now);
    expect(sm.verifyToken(token, now + 500)).toBe(true);
    expect(sm.verifyToken(token, now + 2000)).toBe(false);
  });

  it('未定義・空・形式不正のトークンは弾く', () => {
    const sm = new SessionManager(opts);
    expect(sm.verifyToken(undefined)).toBe(false);
    expect(sm.verifyToken('')).toBe(false);
    expect(sm.verifyToken('no-dot')).toBe(false);
  });

  it('Set-Cookie に HttpOnly / SameSite=Lax が付く', () => {
    const sm = new SessionManager(opts);
    const cookie = sm.buildSetCookie('tok');
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });

  it('secure=true なら Secure 属性を付ける', () => {
    const sm = new SessionManager({ ...opts, secure: true });
    expect(sm.buildSetCookie('tok')).toContain('Secure');
  });

  it('クリア Cookie は Max-Age=0', () => {
    const sm = new SessionManager(opts);
    expect(sm.buildClearCookie()).toContain('Max-Age=0');
  });

  it('readCookie は Cookie ヘッダから本セッション値だけ取り出す', () => {
    expect(SessionManager.readCookie(undefined)).toBeUndefined();
    expect(SessionManager.readCookie('foo=1; ' + SESSION_COOKIE + '=abc; bar=2')).toBe('abc');
    expect(SessionManager.readCookie('foo=1; bar=2')).toBeUndefined();
  });
});

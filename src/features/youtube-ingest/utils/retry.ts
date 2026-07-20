/**
 * リトライユーティリティ - 秋好ナレッジシステム
 *
 * 一時的な失敗（ネットワーク断・HTTP 429・5xx）に対してのみ、
 * 指数バックオフ＋フルジッタで再試行する小さなヘルパー。
 * 恒久的な失敗（字幕なし・入力検証エラー等）は isRetryable が false を返すので
 * 即座に throw され、無駄なリトライで API を叩き続けない。
 */

export interface RetryOptions {
  /** 最大試行回数（初回を含む。既定 3） */
  maxAttempts?: number;
  /** バックオフの基準ミリ秒（既定 500） */
  baseMs?: number;
  /** バックオフの上限ミリ秒（既定 8000） */
  capMs?: number;
  /** この誤りは再試行してよいか（既定: すべて true） */
  isRetryable?: (error: unknown) => boolean;
  /** スリープ実装（テストで差し替える。既定は setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 再試行の直前に呼ばれる（ログ用・任意） */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fn を最大 maxAttempts 回試行する。
 * isRetryable が false を返した誤り、または最終試行の誤りはそのまま throw する。
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 500;
  const capMs = options.capMs ?? 8000;
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 恒久的な失敗、または最終試行ならリトライしない
      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }

      // delay = min(cap, base * 2^(attempt-1)) にフルジッタ (0.5..1.0) を掛ける
      const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const delayMs = Math.floor(exp * (0.5 + Math.random() * 0.5));

      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  // 到達しない（ループ内で必ず return か throw する）が、型の完全性のため
  throw lastError;
}

/**
 * HTTP ステータスや Anthropic SDK のエラー形状から「一時的な失敗か」を判定する。
 * 429（レート制限）・5xx（サーバ障害）・ネットワーク断は再試行、
 * 4xx（認証・入力検証など）は再試行しない。
 */
export function isTransientError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status !== null) {
    if (status === 429) return true;
    if (status >= 500) return true;
    return false; // 4xx は恒久的
  }
  // ステータス不明（ネットワーク断・タイムアウト等）は一時的とみなす
  return true;
}

function extractStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as Record<string, unknown>;
  // Anthropic SDK は APIError に .status を持つ。fetch 系は .status / .statusCode。
  for (const key of ['status', 'statusCode']) {
    const v = e[key];
    if (typeof v === 'number') return v;
  }
  return null;
}

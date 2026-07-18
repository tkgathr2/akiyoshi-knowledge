/**
 * エラー型定義 - 秋好ナレッジシステム
 * 構造化エラーハンドリングのための専用例外クラス
 */

/**
 * Notion API 呼び出しエラー
 * - 認証失敗（401）
 * - 権限不足（403）
 * - API エラー（4xx/5xx）
 */
export class NotionFetchError extends Error {
  constructor(
    public statusCode: number,
    public notionErrorCode?: string,
    message?: string
  ) {
    super(message || `Notion API error: ${statusCode}`);
    this.name = 'NotionFetchError';
    Object.setPrototypeOf(this, NotionFetchError.prototype);
  }

  /**
   * 権限構造的エラー（即座にリトライ打ち切り対象）
   */
  isStructuralError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  /**
   * リトライ可能なエラー
   */
  isRetryable(): boolean {
    return !this.isStructuralError() && (this.statusCode === 429 || this.statusCode >= 500);
  }
}

/**
 * タイムアウトエラー
 * - 全体 4秒でリクエスト打ち切り
 * - L1 フォールバックにシフト
 */
export class TimeoutError extends Error {
  constructor(
    public elapsed: number,
    public timeoutMs: number
  ) {
    super(`Timeout after ${elapsed}ms (limit: ${timeoutMs}ms)`);
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * プロンプトインジェクション検出エラー
 * - 危険なパターンがナレッジ内に検出された
 */
export class InjectionDetectedError extends Error {
  constructor(public suspiciousPatterns: string[]) {
    super(`Injection patterns detected: ${suspiciousPatterns.join(', ')}`);
    this.name = 'InjectionDetectedError';
    Object.setPrototypeOf(this, InjectionDetectedError.prototype);
  }
}

/**
 * キャッシュ関連エラー
 */
export class CacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheError';
    Object.setPrototypeOf(this, CacheError.prototype);
  }
}

/**
 * Notion API ラッパー - 秋好ナレッジシステム
 * リトライ・タイムアウト・権限チェック完全実装
 */

import { Client } from '@notionhq/client';
import { NotionFetchError, TimeoutError } from '../types/errors';
import { KnowledgeEntry } from '../types/knowledge';
import pino from 'pino';

/**
 * Notion API クライアント
 * - リトライ: 指数バックオフ + ジッター
 * - タイムアウト: 全体 4 秒で打ち切り → L1 フォールバック
 * - 権限チェック: 401/403 は即失敗
 */
export class NotionKnowledgeClient {
  private readonly TIMEOUT_MS = 4000;
  private readonly RETRY_MAX = 3;
  private readonly RETRY_INITIAL_MS = 200;
  private readonly RETRY_MULTIPLIER = 2.0;
  private readonly MAX_RETRY_DELAY_MS = 1500;

  private client: Client;
  private logger: pino.Logger;

  constructor(
    apiKey: string,
    private pageId: string,
    logger?: pino.Logger
  ) {
    this.client = new Client({ auth: apiKey });
    this.logger = logger || pino({ name: 'NotionKnowledgeClient' });
  }

  /**
   * Notion から最新ナレッジを取得
   * @param limit 取得件数（デフォルト: 10）
   * @returns KnowledgeEntry[]
   * @throws NotionFetchError, TimeoutError
   */
  async fetchLatest(limit: number = 10): Promise<KnowledgeEntry[]> {
    const startTime = Date.now();

    try {
      const entries = await this.withTimeout(
        this.retryWithBackoff(
          () => this.queryDatabase(limit),
          this.RETRY_MAX
        ),
        this.TIMEOUT_MS
      );

      this.logger.info(
        { duration: Date.now() - startTime, count: entries.length },
        'Notion fetch succeeded'
      );

      return entries;
    } catch (error) {
      const elapsed = Date.now() - startTime;

      if (error instanceof TimeoutError) {
        this.logger.warn(
          { elapsed, timeout: this.TIMEOUT_MS },
          'Notion fetch timeout'
        );
        throw error;
      }

      if (error instanceof NotionFetchError) {
        this.logger.warn(
          { statusCode: error.statusCode, elapsed, structural: error.isStructuralError() },
          'Notion fetch error'
        );
        throw error;
      }

      // Unknown error
      this.logger.error({ error, elapsed }, 'Notion fetch unknown error');
      throw error;
    }
  }

  /**
   * Notion Database クエリ実行
   * POST /v1/databases/{db_id}/query
   */
  private async queryDatabase(limit: number): Promise<KnowledgeEntry[]> {
    try {
      const response = await this.client.databases.query({
        database_id: this.pageId,
        page_size: Math.min(limit, 100),
        sorts: [
          {
            timestamp: 'created_time',
            direction: 'descending',
          },
        ],
        filter: {
          property: 'status',
          status: {
            // Notion ワークスペースの status プロパティは日本語テンプレート既定（未着手/進行中/完了）。
            // API からは英語名のオプションを作成できないため、実運用データベースの完了オプション名に合わせる。
            equals: '完了',
          },
        },
      });

      return response.results.map((page) => this.mapPageToEntry(page));
    } catch (error) {
      // Notion SDK の APIResponseError（status/code を持つ）を NotionFetchError へ変換。
      // status 401/403 は NotionFetchError.isStructuralError()=true となり、
      // retryWithBackoff で即リトライ打ち切りの対象になる。
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === 'number') {
        const notionErrorCode = (error as { code?: string }).code;
        const message = error instanceof Error ? error.message : undefined;
        throw new NotionFetchError(status, notionErrorCode, message);
      }

      throw error; // status を持たない未知のエラーはそのまま伝播
    }
  }

  /**
   * Notion ページをナレッジエントリにマッピング
   */
  private mapPageToEntry(page: any): KnowledgeEntry {
    const props = page.properties || {};

    return {
      id: page.id,
      title: this.extractText(props.title) || 'Untitled',
      summary: this.extractText(props.summary) || '',
      thinkingType: this.extractText(props.thinking_type) || undefined,
      createdAt: new Date(page.created_time),
      lastEditedAt: new Date(page.last_edited_time),
      sourceUrl: page.url || undefined,
    };
  }

  /**
   * Notion プロパティから テキスト抽出
   */
  private extractText(prop: any): string | null {
    if (!prop) return null;

    if (prop.type === 'title' && prop.title) {
      return prop.title.map((t: any) => t.plain_text).join('');
    }

    if (prop.type === 'rich_text' && prop.rich_text) {
      return prop.rich_text.map((t: any) => t.plain_text).join('');
    }

    return null;
  }

  /**
   * 指数バックオフ + ジッター付きリトライ
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // 構造的エラー（401/403）は即リトライ打ち切り
        if (error instanceof NotionFetchError && error.isStructuralError()) {
          this.logger.warn(
            { statusCode: error.statusCode, attempt },
            'Structural error - stop retrying'
          );
          throw error;
        }

        // リトライ可能なら待機
        if (attempt < maxRetries) {
          const delayMs = this.calculateBackoffDelay(attempt);
          this.logger.debug(
            { attempt, delay: delayMs, error: error instanceof Error ? error.message : String(error) },
            'Retrying after backoff'
          );
          await this.sleep(delayMs);
        }
      }
    }

    // 全リトライ失敗
    throw lastError || new Error('Retry exhausted');
  }

  /**
   * 指数バックオフ遅延計算
   * delay = initialMs * (multiplier ^ attempt) + jitter
   */
  private calculateBackoffDelay(attempt: number): number {
    const exponential = this.RETRY_INITIAL_MS * Math.pow(this.RETRY_MULTIPLIER, attempt);
    const capped = Math.min(exponential, this.MAX_RETRY_DELAY_MS);
    const jitter = Math.random() * 0.1 * capped; // ±10% ジッター
    return Math.floor(capped + jitter);
  }

  /**
   * タイムアウト付きで Promise を実行
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new TimeoutError(timeoutMs, timeoutMs));
        }, timeoutMs);

        // promise が解決したら timer をクリア
        promise
          .then(() => clearTimeout(timer))
          .catch(() => clearTimeout(timer));
      }),
    ]);
  }

  /**
   * スリープ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * トークンをマスキング（ログ用）
   */
  static maskToken(token: string): string {
    if (token.length < 4) return '****';
    return token.slice(0, 2) + '****' + token.slice(-2);
  }
}

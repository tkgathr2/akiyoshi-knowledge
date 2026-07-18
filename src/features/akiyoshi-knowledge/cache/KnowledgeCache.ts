/**
 * ナレッジキャッシュ - 秋好ナレッジシステム
 * TTL + single-flight + stale-while-error 実装
 */

import { KnowledgeEntry, KnowledgeLog, CacheEntry } from '../types/knowledge';
import pino from 'pino';

/**
 * ナレッジキャッシュ
 * - TTL: 300 秒固定
 * - single-flight: 同一キーの並行取得を 1 本に集約
 * - stale-while-error: TTL超過でも取得失敗時は古いキャッシュを使用
 * - キャッシュ破壊防止: 失敗時はキャッシュを上書きしない
 */
export class KnowledgeCache {
  private readonly TTL_SECONDS = 300;
  private cache: Map<string, CacheEntry> = new Map();
  private inflight: Map<string, Promise<KnowledgeEntry[]>> = new Map();

  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger = logger || pino({ name: 'KnowledgeCache' });
  }

  /**
   * キャッシュを取得
   * - キャッシュが有効（TTL内）なら即座に返す
   * - 無効なら single-flight で fetchFn() を 1 回実行
   * - 取得成功: キャッシュ更新 + KnowledgeLog 返却
   * - 取得失敗: stale-while-error で期限切れキャッシュを試す
   */
  async get(
    key: string,
    fetchFn: () => Promise<KnowledgeEntry[]>
  ): Promise<KnowledgeLog> {
    // 1. 有効なキャッシュがあるか確認
    const validCache = this.getValidCache(key);
    if (validCache) {
      this.logger.debug({ key, cacheAge: this.getCacheAge(key) }, 'Cache hit');
      return {
        entries: validCache.entries,
        retrievedAt: validCache.storedAt,
        source: 'cache',
        cacheAge: this.getCacheAge(key),
      };
    }

    // 2. single-flight: 同一キーの並行取得を 1 本に集約
    if (this.inflight.has(key)) {
      this.logger.debug({ key }, 'Using in-flight request');
      const entries = await this.inflight.get(key)!;
      return {
        entries,
        retrievedAt: new Date(),
        source: 'notion',
      };
    }

    // 3. 新しいリクエストを開始
    const fetchPromise = fetchFn();
    this.inflight.set(key, fetchPromise);

    try {
      const entries = await fetchPromise;

      // キャッシュ更新
      this.setCache(key, entries);

      this.logger.debug({ key, count: entries.length }, 'Fetch succeeded and cached');

      return {
        entries,
        retrievedAt: new Date(),
        source: 'notion',
      };
    } catch (error) {
      // 4. stale-while-error: TTL超過でも取得失敗時は古いキャッシュを使用
      const staleCache = this.getStaleCache(key);
      if (staleCache) {
        this.logger.warn(
          { key, cacheAge: this.getCacheAge(key), error: error instanceof Error ? error.message : String(error) },
          'Fetch failed - using stale cache'
        );
        return {
          entries: staleCache.entries,
          retrievedAt: staleCache.storedAt,
          source: 'stale-cache',
          cacheAge: this.getCacheAge(key),
        };
      }

      // キャッシュなし → エラーを伝播
      this.logger.error({ key, error }, 'Fetch failed and no stale cache available');
      throw error;
    } finally {
      // in-flight を削除
      this.inflight.delete(key);
    }
  }

  /**
   * 有効なキャッシュを取得（TTL内）
   */
  private getValidCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const expiresAtMs = entry.expiresAt.getTime();

    if (now < expiresAtMs) {
      return entry;
    }

    return null;
  }

  /**
   * TTL超過でも古いキャッシュを取得（stale-while-error）
   */
  private getStaleCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // TTL超過でも返す（stale-while-error）
    return entry;
  }

  /**
   * キャッシュエントリを設定
   * @param key キャッシュキー
   * @param entries ナレッジエントリ
   */
  private setCache(key: string, entries: KnowledgeEntry[]): void {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.TTL_SECONDS * 1000);

    this.cache.set(key, {
      entries,
      storedAt: now,
      expiresAt,
      source: 'notion',
    });

    this.logger.debug(
      { key, ttl: this.TTL_SECONDS, count: entries.length },
      'Cache updated'
    );
  }

  /**
   * キャッシュ経過秒数を計算
   */
  private getCacheAge(key: string): number {
    const entry = this.cache.get(key);
    if (!entry) return 0;

    const ageMs = Date.now() - entry.storedAt.getTime();
    return Math.floor(ageMs / 1000);
  }

  /**
   * キャッシュをクリア
   * @param key キーが指定されたら特定エントリのみクリア、未指定なら全削除
   */
  clear(key?: string): void {
    if (key) {
      this.cache.delete(key);
      this.logger.debug({ key }, 'Cache entry cleared');
    } else {
      this.cache.clear();
      this.inflight.clear();
      this.logger.debug('All cache cleared');
    }
  }

  /**
   * キャッシュサイズ（テスト用）
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * キャッシュの状態を確認（テスト用）
   */
  getState(key: string): { valid: boolean; age: number; expiresAt: Date } | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const expiresAtMs = entry.expiresAt.getTime();
    const valid = now < expiresAtMs;

    return {
      valid,
      age: this.getCacheAge(key),
      expiresAt: entry.expiresAt,
    };
  }
}

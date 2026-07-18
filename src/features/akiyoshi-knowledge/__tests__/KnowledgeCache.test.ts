/**
 * KnowledgeCache テスト
 * UT-105, UT-106, UT-109 対象
 */

import { KnowledgeCache } from '../cache/KnowledgeCache';
import { KnowledgeEntry } from '../types/knowledge';
import pino from 'pino';

describe('KnowledgeCache', () => {
  let cache: KnowledgeCache;
  const logger = pino({ level: 'silent' });

  const mockEntries: KnowledgeEntry[] = [
    {
      id: 'entry-1',
      title: 'Entry 1',
      summary: 'Summary 1',
      createdAt: new Date('2026-07-18T10:00:00Z'),
      lastEditedAt: new Date('2026-07-18T10:00:00Z'),
    },
    {
      id: 'entry-2',
      title: 'Entry 2',
      summary: 'Summary 2',
      createdAt: new Date('2026-07-18T11:00:00Z'),
      lastEditedAt: new Date('2026-07-18T11:00:00Z'),
    },
  ];

  beforeEach(() => {
    cache = new KnowledgeCache(logger);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('UT-105: TTL管理', () => {
    it('should return cached value within TTL', async () => {
      const fetchFn = jest.fn().mockResolvedValueOnce(mockEntries);
      const key = 'test-key';

      // 1 回目: キャッシュなし → fetch
      const result1 = await cache.get(key, fetchFn);
      expect(result1.source).toBe('notion');
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // 2 回目: キャッシュ有効 → fetch しない
      const result2 = await cache.get(key, fetchFn);
      expect(result2.source).toBe('cache');
      expect(result2.cacheAge).toBeLessThan(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // 両結果が同じ
      expect(result2.entries).toEqual(mockEntries);
    });

    it('should invalidate cache after TTL (300 seconds)', async () => {
      const fetchFn = jest.fn().mockResolvedValue(mockEntries);
      const key = 'test-key';

      // 1 回目: キャッシュなし → fetch
      await cache.get(key, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // 299 秒後: キャッシュ有効
      jest.advanceTimersByTime(299000);
      await cache.get(key, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // 301 秒後: キャッシュ無効 → fetch
      jest.advanceTimersByTime(2000);
      await cache.get(key, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('should report correct cache age', async () => {
      const fetchFn = jest.fn().mockResolvedValueOnce(mockEntries);
      const key = 'test-key';

      await cache.get(key, fetchFn);
      expect(cache.getState(key)?.age).toBe(0);

      jest.advanceTimersByTime(50000);
      const result = await cache.get(key, fetchFn);
      expect(result.cacheAge).toBe(50);
    });

    it('should handle empty entries', async () => {
      const fetchFn = jest.fn().mockResolvedValueOnce([]);
      const key = 'test-key';

      const result = await cache.get(key, fetchFn);
      expect(result.entries).toEqual([]);
      expect(result.source).toBe('notion');
    });
  });

  describe('UT-106: single-flight', () => {
    it('should deduplicate concurrent requests with same key', async () => {
      const fetchFn = jest.fn();
      let resolveFirst: any;
      const delayedPromise = new Promise<KnowledgeEntry[]>((resolve) => {
        resolveFirst = resolve;
      });

      fetchFn.mockReturnValueOnce(delayedPromise);

      const key = 'test-key';

      // 3 つの並行リクエストを発行
      const promise1 = cache.get(key, fetchFn);
      const promise2 = cache.get(key, fetchFn);
      const promise3 = cache.get(key, fetchFn);

      // fetch 関数は 1 回だけ呼ばれるべき
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Promise を解決
      resolveFirst(mockEntries);

      const [result1, result2, result3] = await Promise.all([
        promise1,
        promise2,
        promise3,
      ]);

      // 全て同じ結果
      expect(result1.entries).toEqual(mockEntries);
      expect(result2.entries).toEqual(mockEntries);
      expect(result3.entries).toEqual(mockEntries);

      // fetch は 1 回だけ
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should allow new request after in-flight completes', async () => {
      const fetchFn = jest.fn().mockResolvedValue(mockEntries);
      const key = 'test-key';

      // 1 回目
      await cache.get(key, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // キャッシュ期限切れ
      jest.advanceTimersByTime(301000);

      // 2 回目: 新しい in-flight リクエスト
      await cache.get(key, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('should handle different keys independently', async () => {
      const fetchFn1 = jest.fn().mockResolvedValueOnce([mockEntries[0]]);
      const fetchFn2 = jest.fn().mockResolvedValueOnce([mockEntries[1]]);

      const key1 = 'key-1';
      const key2 = 'key-2';

      const promise1 = cache.get(key1, fetchFn1);
      const promise2 = cache.get(key2, fetchFn2);

      await Promise.all([promise1, promise2]);

      expect(fetchFn1).toHaveBeenCalledTimes(1);
      expect(fetchFn2).toHaveBeenCalledTimes(1);
    });
  });

  describe('UT-109: キャッシュ破壊防止', () => {
    it('should not overwrite cache on fetch failure', async () => {
      const fetchFn1 = jest
        .fn()
        .mockResolvedValueOnce(mockEntries.slice(0, 1));
      const fetchFn2 = jest.fn().mockRejectedValueOnce(new Error('Fetch failed'));

      const key = 'test-key';

      // 1 回目: 正常に取得・キャッシュ
      const result1 = await cache.get(key, fetchFn1);
      expect(result1.source).toBe('notion');
      expect(result1.entries).toHaveLength(1);

      // キャッシュ期限切れ
      jest.advanceTimersByTime(301000);

      // 2 回目: 取得失敗 → stale-while-error で古いキャッシュを返す
      const result2 = await cache.get(key, fetchFn2);
      expect(result2.source).toBe('stale-cache');
      expect(result2.entries).toHaveLength(1);
      expect(result2.entries).toEqual(mockEntries.slice(0, 1));

      // 3 回目: キャッシュは更新されていない（古い状態のまま）
      jest.advanceTimersByTime(301000);
      const result3 = await cache.get(key, () => Promise.resolve(mockEntries));
      expect(result3.source).toBe('notion');
      expect(result3.entries).toHaveLength(2);
    });

    it('should throw error when no stale cache and fetch fails', async () => {
      const fetchFn = jest.fn().mockRejectedValueOnce(new Error('Fetch failed'));
      const key = 'test-key';

      // キャッシュなしで fetch 失敗
      await expect(cache.get(key, fetchFn)).rejects.toThrow('Fetch failed');
    });

    it('should preserve stale cache even after error', async () => {
      const fetchFn1 = jest.fn().mockResolvedValueOnce([mockEntries[0]]);
      const fetchFn2 = jest.fn().mockRejectedValueOnce(new Error('API error'));
      const fetchFn3 = jest.fn().mockRejectedValueOnce(new Error('Network error'));

      const key = 'test-key';

      // 正常取得
      await cache.get(key, fetchFn1);

      // TTL 期限切れ
      jest.advanceTimersByTime(301000);

      // 1 回目の失敗
      const result2 = await cache.get(key, fetchFn2);
      expect(result2.source).toBe('stale-cache');

      // 2 回目の失敗: 古いキャッシュはまだ使える
      const result3 = await cache.get(key, fetchFn3);
      expect(result3.source).toBe('stale-cache');
      expect(result3.entries).toEqual([mockEntries[0]]);
    });

    it('should not update cache metadata on fetch failure', async () => {
      const fetchFn1 = jest
        .fn()
        .mockResolvedValueOnce(mockEntries.slice(0, 1));
      const fetchFn2 = jest.fn().mockRejectedValueOnce(new Error('Fetch failed'));

      const key = 'test-key';

      // 正常取得
      const result1 = await cache.get(key, fetchFn1);
      const state1 = cache.getState(key)!;

      // TTL 期限切れ
      jest.advanceTimersByTime(301000);

      // 失敗してもキャッシュメタデータは更新されない
      await cache.get(key, fetchFn2);
      const state2 = cache.getState(key)!;

      // storedAt は同じ（更新されない）
      expect(state2.expiresAt.getTime()).toBe(state1.expiresAt.getTime());
    });
  });

  describe('Cache management', () => {
    it('should clear specific cache entry', async () => {
      const fetchFn = jest.fn().mockResolvedValue(mockEntries);
      const key = 'test-key';

      await cache.get(key, fetchFn);
      expect(cache.size()).toBe(1);

      cache.clear(key);
      expect(cache.size()).toBe(0);
    });

    it('should clear all cache', async () => {
      const fetchFn = jest.fn().mockResolvedValue(mockEntries);

      await cache.get('key-1', fetchFn);
      await cache.get('key-2', fetchFn);
      expect(cache.size()).toBe(2);

      cache.clear();
      expect(cache.size()).toBe(0);
    });

    it('should return null state for non-existent key', () => {
      const state = cache.getState('non-existent-key');
      expect(state).toBeNull();
    });

    it('should report valid state within TTL', () => {
      const fetchFn = jest.fn().mockResolvedValue(mockEntries);
      const key = 'test-key';

      cache.get(key, fetchFn).then(() => {
        const state = cache.getState(key);
        expect(state).not.toBeNull();
        expect(state?.valid).toBe(true);
        expect(state?.age).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle 11 entries (exceeding typical batch size)', async () => {
      const largeEntries = Array.from({ length: 11 }, (_, i) => ({
        id: `entry-${i}`,
        title: `Entry ${i}`,
        summary: `Summary ${i}`,
        createdAt: new Date(),
        lastEditedAt: new Date(),
      }));

      const fetchFn = jest.fn().mockResolvedValueOnce(largeEntries);

      const result = await cache.get('large-key', fetchFn);
      expect(result.entries).toHaveLength(11);
    });

    it('should handle null/undefined in fetch result gracefully', async () => {
      const fetchFn = jest.fn().mockResolvedValueOnce(mockEntries);

      const result = await cache.get('test-key', fetchFn);
      expect(result.entries).toBeDefined();
      expect(Array.isArray(result.entries)).toBe(true);
    });
  });
});

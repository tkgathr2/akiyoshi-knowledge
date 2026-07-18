/**
 * MetricsCollector テスト
 * P0-3: totalOps/errorRate/successRate 計算式の実値ベース修正
 */

import { MetricsCollector, OperationRecord } from '../MetricsCollector';
import pino from 'pino';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    collector = new MetricsCollector(logger);
  });

  function record(operation: OperationRecord['operation'], count: number, sourceType: OperationRecord['sourceType'] = 'notion') {
    for (let i = 0; i < count; i++) {
      collector.recordOperation({
        timestamp: new Date(),
        operation,
        latency: 100,
        sourceType,
      });
    }
  }

  describe('P0-3: totalOps', () => {
    it('should expose totalOps as fetch + cache_hit + fallback (excluding error/cache_miss)', () => {
      record('fetch', 50);
      record('cache_hit', 30);
      record('fallback', 5);
      record('error', 6);
      record('cache_miss', 2);

      const snapshot = collector.getCurrentMetrics();

      // totalOps = 50 + 30 + 5 = 85 (error/cache_missは含まない)
      expect(snapshot.totalOps).toBe(85);
    });
  });

  describe('P0-3: successRate', () => {
    it('should return 100% when cache_hit(50) + fetch(50) are the only ops', () => {
      record('cache_hit', 50);
      record('fetch', 50);

      const snapshot = collector.getCurrentMetrics();

      expect(snapshot.totalOps).toBe(100);
      expect(snapshot.successRate).toBe(100);
    });

    it('should return 0 (not 100) when there are zero operations', () => {
      const snapshot = collector.getCurrentMetrics();

      expect(snapshot.totalOps).toBe(0);
      expect(snapshot.successRate).toBe(0);
    });

    it('should count only fetch+cache_hit as success (not just fetch)', () => {
      record('fetch', 10);
      record('cache_hit', 10);
      record('fallback', 0);

      const snapshot = collector.getCurrentMetrics();

      // successOps = 20, totalOps = 20 -> 100%
      expect(snapshot.successRate).toBe(100);
    });
  });

  describe('P0-3: generateDailyAggregation definition consistency', () => {
    it('should use the same success definition as getCurrentMetrics', () => {
      record('fetch', 40);
      record('cache_hit', 40);
      record('fallback', 20);

      const snapshot = collector.getCurrentMetrics();
      const aggregation = collector.generateDailyAggregation(new Date());

      // 同一データセットに対して同一の successRate 定義（fetch+cache_hit / fetch+cache_hit+fallback）
      expect(aggregation.avgSuccessRate).toBe(snapshot.successRate);
      expect(aggregation.avgSuccessRate).toBe(80); // (40+40)/(40+40+20)*100
    });

    it('should return 0 (not 100) when there are zero operations in the day', () => {
      const aggregation = collector.generateDailyAggregation(new Date());
      expect(aggregation.avgSuccessRate).toBe(0);
    });
  });
});

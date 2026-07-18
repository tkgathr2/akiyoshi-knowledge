/**
 * メトリクス収集エンジン - 9メトリクスのリアルタイム追跡
 * 秋好ナレッジシステム本番監視
 */

import pino from 'pino';
import { MetricSnapshot, DailyAggregation } from './types/metrics';

export interface OperationRecord {
  timestamp: Date;
  operation: 'fetch' | 'cache_hit' | 'cache_miss' | 'fallback' | 'error';
  latency: number; // ms
  sourceType: 'notion' | 'cache' | 'fallback';
  statusCode?: number;
  errorMessage?: string;
}

export class MetricsCollector {
  private records: OperationRecord[] = [];
  private readonly WINDOW_SIZE_MS = 24 * 60 * 60 * 1000; // 24時間
  private logger: pino.Logger;

  // 状態トラッキング
  private circuitBreakerOpen: boolean = false;
  private cacheSize: number = 0;
  private maxCacheSize: number = 1024 * 1024 * 100; // 100MB

  constructor(logger?: pino.Logger) {
    this.logger = logger || pino({ name: 'MetricsCollector' });
  }

  /**
   * オペレーション記録
   */
  recordOperation(operation: OperationRecord): void {
    this.records.push(operation);

    // 24時間以上古いレコードは削除
    const cutoffTime = new Date(Date.now() - this.WINDOW_SIZE_MS);
    this.records = this.records.filter((r) => r.timestamp > cutoffTime);

    if (operation.operation === 'error') {
      this.logger.warn(
        {
          operation: operation.operation,
          latency: operation.latency,
          status: operation.statusCode,
          error: operation.errorMessage,
        },
        'Operation error recorded'
      );
    }
  }

  /**
   * 現在のメトリクス スナップショット取得
   */
  getCurrentMetrics(): MetricSnapshot {
    const now = new Date();

    // 直近1時間のレコード抽出
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const recentRecords = this.records.filter((r) => r.timestamp > oneHourAgo);

    // メトリクス計算
    const totalOps = recentRecords.length;
    const successOps = recentRecords.filter((r) => r.operation === 'fetch').length;
    const cacheHits = recentRecords.filter((r) => r.operation === 'cache_hit').length;
    const fallbacks = recentRecords.filter((r) => r.operation === 'fallback').length;
    const errors = recentRecords.filter((r) => r.operation === 'error').length;

    const successRate = totalOps > 0 ? (successOps / totalOps) * 100 : 100;
    const cacheHitRate = totalOps > 0 ? (cacheHits / totalOps) * 100 : 0;

    // レイテンシ計算（平均）
    const latencies = recentRecords.map((r) => r.latency);
    const avgLatency =
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

    // Notion API応答時間（Notion源の平均）
    const notionRecords = recentRecords.filter((r) => r.sourceType === 'notion');
    const notionApiResponseTime =
      notionRecords.length > 0
        ? notionRecords.reduce((sum, r) => sum + r.latency, 0) / notionRecords.length
        : 0;

    // Slack通知数（集約確認）
    const slackNotificationCount = errors; // エラーペケットごとに1通知

    // キャッシュ利用率
    const cacheUtilizationPercent = (this.cacheSize / this.maxCacheSize) * 100;

    return {
      timestamp: now,
      successRate: Math.round(successRate * 100) / 100,
      avgLatency: Math.round(avgLatency * 100) / 100,
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      errorCount: errors,
      slackNotificationCount,
      circuitBreakerOpen: this.circuitBreakerOpen,
      fallbackCount: fallbacks,
      notionApiResponseTime: Math.round(notionApiResponseTime * 100) / 100,
      cacheUtilizationPercent: Math.round(cacheUtilizationPercent * 100) / 100,
    };
  }

  /**
   * Circuit Breaker状態更新
   */
  setCircuitBreakerOpen(open: boolean): void {
    if (this.circuitBreakerOpen !== open) {
      this.circuitBreakerOpen = open;
      this.logger.info(
        { circuitBreakerOpen: open },
        'Circuit Breaker state changed'
      );
    }
  }

  /**
   * キャッシュサイズ更新
   */
  setCacheSize(bytes: number): void {
    this.cacheSize = bytes;
  }

  /**
   * 日次集計生成
   */
  generateDailyAggregation(date: Date): DailyAggregation {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const dayRecords = this.records.filter(
      (r) => r.timestamp >= startOfDay && r.timestamp <= endOfDay
    );

    const successRates = dayRecords
      .filter((r) => ['fetch', 'cache_hit', 'error'].includes(r.operation))
      .map((r) => (r.operation === 'error' ? 0 : 1));

    const successSum = successRates.reduce((a: number, b: number) => a + b, 0);
    const avgSuccessRate =
      successRates.length > 0
        ? (successSum / successRates.length) * 100
        : 100;

    // P95レイテンシ計算
    const latencies = dayRecords.map((r) => r.latency).sort((a, b) => a - b);
    const p95Idx = Math.ceil(latencies.length * 0.95) - 1;
    const p95Latency = latencies[Math.max(0, p95Idx)] || 0;

    const cacheHits = dayRecords.filter((r) => r.operation === 'cache_hit').length;
    const avgCacheHitRate =
      dayRecords.length > 0 ? (cacheHits / dayRecords.length) * 100 : 0;

    const errors = dayRecords.filter((r) => r.operation === 'error').length;
    const fallbacks = dayRecords.filter((r) => r.operation === 'fallback').length;

    const notionRecords = dayRecords.filter((r) => r.sourceType === 'notion');
    const avgNotionApiResponseTime =
      notionRecords.length > 0
        ? notionRecords.reduce((sum, r) => sum + r.latency, 0) / notionRecords.length
        : 0;

    return {
      date,
      avgSuccessRate: Math.round(avgSuccessRate * 100) / 100,
      p95Latency: Math.round(p95Latency * 100) / 100,
      avgCacheHitRate: Math.round(avgCacheHitRate * 100) / 100,
      totalErrors: errors,
      totalSlackNotifications: errors, // 1エラー = 1通知
      circuitBreakerOpenCount: this.circuitBreakerOpen ? 1 : 0,
      totalFallbacks: fallbacks,
      avgNotionApiResponseTime: Math.round(avgNotionApiResponseTime * 100) / 100,
      peakCacheUtilization: (this.cacheSize / this.maxCacheSize) * 100,
      alertsTriggered: 0, // TODO: アラートエンジン連携
    };
  }

  /**
   * メトリクス履歴取得（テスト・検証用）
   */
  getRecentRecords(minutes: number = 60): OperationRecord[] {
    const cutoffTime = new Date(Date.now() - minutes * 60 * 1000);
    return this.records.filter((r) => r.timestamp > cutoffTime);
  }

  /**
   * 統計情報
   */
  getStatistics() {
    const totalRecords = this.records.length;
    const successfulOps = this.records.filter(
      (r) => r.operation === 'fetch' || r.operation === 'cache_hit'
    ).length;
    const errorOps = this.records.filter((r) => r.operation === 'error').length;

    return {
      totalRecords,
      successfulOps,
      errorOps,
      successRate: totalRecords > 0 ? (successfulOps / totalRecords) * 100 : 100,
      circuitBreakerOpen: this.circuitBreakerOpen,
      cacheUtilizationPercent: (this.cacheSize / this.maxCacheSize) * 100,
    };
  }
}

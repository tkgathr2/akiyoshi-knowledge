/**
 * 24時間監視ダッシュボード - 統合監視エンジン
 * 秋好ナレッジシステム本番運用
 *
 * メトリクス収集 → アラート評価 → 通知送信 → ログ記録
 */

import pino from 'pino';
import { MetricSnapshot, AlertRule, AlertEvent, DailyAggregation } from './types/metrics';
import { MetricsCollector, OperationRecord } from './MetricsCollector';
import { AlertEngine, RuleState } from './AlertEngine';
import { MonitoringLogger } from './MonitoringLogger';
import { NotificationEngine, NotificationConfig } from './NotificationEngine';

export interface DashboardConfig {
  metricsCollectorConfig?: {
    windowSizeMs?: number;
  };
  monitoringLogConfig?: {
    logDirectory?: string;
    retentionDays?: number;
  };
  notificationConfig?: NotificationConfig;
  updateIntervalMs?: number; // デフォルト: 60秒
  dailyAggregationTimes?: string[]; // e.g., ["00:00", "12:00"] UTC
}

export class MonitoringDashboard {
  private metricsCollector: MetricsCollector;
  private alertEngine: AlertEngine;
  private monitoringLogger: MonitoringLogger;
  private notificationEngine: NotificationEngine;
  private logger: pino.Logger;

  private updateIntervalMs: number = 60 * 1000; // 1分
  private updateTimer: NodeJS.Timeout | null = null;
  private dailyAggregationTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  private dailyAggregationTimes: string[] = ['00:00', '12:00']; // UTC
  private lastMetricSnapshot: MetricSnapshot | null = null;
  private alertHistory: AlertEvent[] = [];

  constructor(config: DashboardConfig = {}, logger?: pino.Logger) {
    this.logger = logger || pino({ name: 'MonitoringDashboard' });

    // コンポーネント初期化
    this.metricsCollector = new MetricsCollector(this.logger);
    this.alertEngine = new AlertEngine(this.logger);
    this.monitoringLogger = new MonitoringLogger(
      config.monitoringLogConfig?.logDirectory,
      this.logger
    );
    this.notificationEngine = new NotificationEngine(
      config.notificationConfig || { dryRun: false },
      this.logger
    );

    // 設定適用
    if (config.updateIntervalMs) {
      this.updateIntervalMs = config.updateIntervalMs;
    }

    if (config.dailyAggregationTimes) {
      this.dailyAggregationTimes = config.dailyAggregationTimes;
    }

    this.logger.info(
      {
        updateIntervalMs: this.updateIntervalMs,
        dailyAggregationTimes: this.dailyAggregationTimes,
      },
      'Monitoring dashboard initialized'
    );
  }

  /**
   * 監視ダッシュボード起動
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Dashboard already running');
      return;
    }

    this.isRunning = true;

    // アラートルール初期化
    const productionRules = this.alertEngine.initializeProductionRules();
    this.monitoringLogger.logMetric('Production alert rules loaded', {
      ruleCount: productionRules.length,
      ruleIds: productionRules.map((r) => r.id),
    });

    // 自動エクスポート開始
    this.monitoringLogger.startAutoExport();

    // メトリクス更新スケジューラ開始
    this.startMetricsUpdate();

    // 日次集計スケジューラ開始
    this.startDailyAggregationScheduler();

    this.logger.info('Monitoring dashboard started');
    this.monitoringLogger.logMetric('Dashboard status', { status: 'started' });
  }

  /**
   * 監視ダッシュボード停止
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Dashboard not running');
      return;
    }

    this.isRunning = false;

    // タイマーをクリア
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    if (this.dailyAggregationTimer) {
      clearInterval(this.dailyAggregationTimer);
      this.dailyAggregationTimer = null;
    }

    // 自動エクスポート停止
    this.monitoringLogger.stopAutoExport();

    // 最終ログをエクスポート
    this.monitoringLogger.exportLogs();

    this.logger.info('Monitoring dashboard stopped');
    this.monitoringLogger.logMetric('Dashboard status', { status: 'stopped' });
  }

  /**
   * メトリクス更新スケジューラ
   */
  private startMetricsUpdate(): void {
    // 初回は即座に実行
    this.updateMetrics();

    // 定期実行
    this.updateTimer = setInterval(() => {
      this.updateMetrics();
    }, this.updateIntervalMs);

    this.logger.info(
      { intervalMs: this.updateIntervalMs },
      'Metrics update scheduler started'
    );
  }

  /**
   * メトリクス更新・アラート評価・通知送信
   */
  private async updateMetrics(): Promise<void> {
    try {
      // 現在のメトリクスを取得
      const snapshot = this.metricsCollector.getCurrentMetrics();

      // M3修正: NotificationEngineの実Slack通知失敗数をsnapshotに注入（ALERT-008の実データ化）
      snapshot.slackNotificationFailureCount = this.notificationEngine.getRecentFailureCount();

      this.lastMetricSnapshot = snapshot;

      // メトリクスをログ記録
      this.monitoringLogger.logMetric('Metrics snapshot', {
        timestamp: snapshot.timestamp.toISOString(),
        successRate: snapshot.successRate,
        avgLatency: snapshot.avgLatency,
        cacheHitRate: snapshot.cacheHitRate,
        errorCount: snapshot.errorCount,
        circuitBreakerOpen: snapshot.circuitBreakerOpen,
      });

      // アラート評価
      const triggeredAlerts = this.alertEngine.evaluateMetrics(snapshot);

      // トリガーされたアラートを処理
      for (const alert of triggeredAlerts) {
        this.alertHistory.push(alert);

        // ルール情報を取得して通知ターゲットを決定
        const rules = this.alertEngine.getRules();
        const rule = rules.find((r) => r.id === alert.ruleId);

        if (rule) {
          // 通知送信
          await this.notificationEngine.sendAlert(alert, rule.notificationTargets);

          // アラートをログ記録
          this.monitoringLogger.logAlert(alert.severity, alert.message, {
            alertId: alert.id,
            ruleId: alert.ruleId,
            metric: alert.metric,
            value: alert.value,
          });
        }
      }

      // 古いアラート履歴を削除（最新1000件のみ保持）
      if (this.alertHistory.length > 1000) {
        this.alertHistory = this.alertHistory.slice(-1000);
      }
    } catch (error) {
      this.logger.error({ error }, 'Error during metrics update');
      this.monitoringLogger.logAlert('error', 'Metrics update failed', { error: String(error) });
    }
  }

  /**
   * 日次集計スケジューラ
   */
  private startDailyAggregationScheduler(): void {
    const scheduleNextRun = () => {
      const now = new Date();
      let nextRunTime: Date | null = null;

      for (const timeStr of this.dailyAggregationTimes) {
        const [hours, minutes] = timeStr.split(':').map(Number);
        const candidateTime = new Date(now);
        candidateTime.setUTCHours(hours, minutes, 0, 0);

        if (candidateTime > now) {
          nextRunTime = candidateTime;
          break;
        }
      }

      // 今日の設定時刻が過ぎていれば、翌日の最初の時刻に設定
      if (!nextRunTime) {
        const [hours, minutes] = this.dailyAggregationTimes[0].split(':').map(Number);
        nextRunTime = new Date(now);
        nextRunTime.setUTCDate(nextRunTime.getUTCDate() + 1);
        nextRunTime.setUTCHours(hours, minutes, 0, 0);
      }

      const delayMs = nextRunTime.getTime() - now.getTime();

      if (this.dailyAggregationTimer) {
        clearTimeout(this.dailyAggregationTimer);
      }

      this.dailyAggregationTimer = setTimeout(async () => {
        await this.runDailyAggregation();
        scheduleNextRun();
      }, delayMs);

      this.logger.debug(
        { nextRunTime: nextRunTime.toISOString(), delayMs },
        'Next daily aggregation scheduled'
      );
    };

    scheduleNextRun();
  }

  /**
   * 日次集計実行
   */
  private async runDailyAggregation(): Promise<void> {
    try {
      const today = new Date();
      const aggregation = this.metricsCollector.generateDailyAggregation(today);

      // 集計結果をログ記録
      this.monitoringLogger.logMetric('Daily aggregation', {
        date: aggregation.date.toISOString(),
        avgSuccessRate: aggregation.avgSuccessRate,
        p95Latency: aggregation.p95Latency,
        avgCacheHitRate: aggregation.avgCacheHitRate,
        totalErrors: aggregation.totalErrors,
        totalSlackNotifications: aggregation.totalSlackNotifications,
      });

      // 日次集計通知を送信
      await this.notificationEngine.sendDailyAggregation(aggregation);

      this.logger.info({ date: today.toISOString() }, 'Daily aggregation completed');
    } catch (error) {
      this.logger.error({ error }, 'Error during daily aggregation');
    }
  }

  /**
   * オペレーション記録
   */
  recordOperation(operation: OperationRecord): void {
    this.metricsCollector.recordOperation(operation);
  }

  /**
   * Circuit Breaker状態更新
   */
  setCircuitBreakerOpen(open: boolean): void {
    this.metricsCollector.setCircuitBreakerOpen(open);

    if (open) {
      this.monitoringLogger.logAlert('critical', 'Circuit Breaker opened', {
        open,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * キャッシュサイズ更新
   */
  setCacheSize(bytes: number): void {
    this.metricsCollector.setCacheSize(bytes);
  }

  /**
   * 現在のメトリクス取得
   */
  getMetrics(): MetricSnapshot | null {
    return this.lastMetricSnapshot;
  }

  /**
   * ダッシュボード状態取得
   */
  getDashboardStatus() {
    return {
      isRunning: this.isRunning,
      lastMetricSnapshot: this.lastMetricSnapshot,
      alertRulesCount: this.alertEngine.getRules().length,
      alertHistoryCount: this.alertHistory.length,
      collectorStats: this.metricsCollector.getStatistics(),
      notificationFailures: this.notificationEngine.getFailedNotificationStats(),
      loggerStats: this.monitoringLogger.getStatistics(),
    };
  }

  /**
   * アラートルール管理
   */
  getRules(): AlertRule[] {
    return this.alertEngine.getRules();
  }

  enableRule(ruleId: string): void {
    this.alertEngine.enableRule(ruleId);
  }

  disableRule(ruleId: string): void {
    this.alertEngine.disableRule(ruleId);
  }

  setTestMode(ruleId: string, dryRun: boolean): void {
    this.alertEngine.setTestMode(ruleId, dryRun);
  }

  setAllTestMode(dryRun: boolean): void {
    this.alertEngine.setAllTestMode(dryRun);
  }

  /**
   * ルール別ステート取得（duration/consecutive評価の継続時間・連続回数・テスト用）
   */
  getRuleState(ruleId: string): RuleState | undefined {
    return this.alertEngine.getRuleState(ruleId);
  }

  /**
   * ログエクスポート
   */
  exportLogs(filename?: string): string {
    return this.monitoringLogger.exportLogs(filename);
  }

  /**
   * アラート履歴取得
   */
  getAlertHistory(limit: number = 100): AlertEvent[] {
    return this.alertHistory.slice(-limit);
  }
}

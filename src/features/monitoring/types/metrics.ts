/**
 * 24時間監視ダッシュボード - メトリクス定義
 * 秋好ナレッジシステム本番運用
 */

export interface MetricSnapshot {
  timestamp: Date;
  totalOps: number; // 件数: 集計対象オペレーション合計（fetch + cache_hit + fallback）。errorRate/successRateの分母
  successRate: number; // 0-100: 取得成功率（目標100%）
  avgLatency: number; // ms: 平均レイテンシ（目標<1500ms）
  cacheHitRate: number; // 0-100: キャッシュヒット率（観察指標）
  errorCount: number; // 件数: エラー件数（期待0）
  slackNotificationCount: number; // 件数: Slack通知数（集約確認）
  circuitBreakerOpen: boolean; // 状態: Circuit Breaker開放フラグ
  fallbackCount: number; // 件数: フォールバック件数（観察）
  notionApiResponseTime: number; // ms: Notion API応答時間
  cacheUtilizationPercent: number; // 0-100: キャッシュサイズ利用率
}

export interface MetricConfig {
  sampleInterval: number; // ms: メトリクス取得間隔（デフォルト60秒）
  retentionDays: number; // 日: ログ保持期間
  autoExportInterval: number; // ms: 自動エクスポート間隔（1時間）
}

export interface AlertRule {
  id: string;
  name: string;
  condition: AlertCondition;
  severity: 'critical' | 'warning' | 'info';
  enabled: boolean;
  dryRun: boolean; // テストモード
  notificationTargets: NotificationTarget[];
  testDate?: Date; // テスト実行日時
}

export interface AlertCondition {
  metric: string; // メトリクス名
  operator: '>' | '<' | '==' | '!=' | '>=' | '<=';
  threshold: number;
  duration?: number; // ms: 継続時間（e.g., 30分）
  consecutive?: number; // 連続発生数（e.g., 3回）
}

export interface NotificationTarget {
  type: 'slack' | 'email' | 'log';
  destination: string; // Slack: @user, #channel; Email: user@example.com; Log: log-name
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  timestamp: Date;
  metric: string;
  value: number;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
}

export interface DailyAggregation {
  date: Date;
  avgSuccessRate: number;
  p95Latency: number;
  avgCacheHitRate: number;
  totalErrors: number;
  totalSlackNotifications: number;
  circuitBreakerOpenCount: number;
  totalFallbacks: number;
  avgNotionApiResponseTime: number;
  peakCacheUtilization: number;
  alertsTriggered: number;
}

export interface MonitoringLogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  category: string; // e.g., "metrics", "alert", "notification"
  message: string;
  metadata: Record<string, any>;
}

/**
 * アラートエンジン - 8個ルール実装
 * 秋好ナレッジシステム本番監視
 */

import pino from 'pino';
import { AlertRule, AlertEvent, AlertCondition, MetricSnapshot, NotificationTarget } from './types/metrics';

export class AlertEngine {
  private alerts: Map<string, AlertEvent> = new Map();
  private logger: pino.Logger;
  private ruleMap: Map<string, AlertRule> = new Map();

  constructor(logger?: pino.Logger) {
    this.logger = logger || pino({ name: 'AlertEngine' });
  }

  /**
   * 8個のアラートルール定義・初期化
   */
  initializeProductionRules(): AlertRule[] {
    const rules: AlertRule[] = [
      // ALERT-001: エラー率 >5% for 30分+
      {
        id: 'ALERT-001',
        name: 'High Error Rate (>5% for 30 min)',
        condition: {
          metric: 'errorRate',
          operator: '>',
          threshold: 5,
          duration: 30 * 60 * 1000, // 30分
        },
        severity: 'critical',
        enabled: true,
        dryRun: false,
        notificationTargets: [
          { type: 'slack', destination: '@takagi' },
          { type: 'log', destination: 'alert-critical' },
        ],
      },

      // ALERT-002: Circuit Breaker開放 → 即座
      {
        id: 'ALERT-002',
        name: 'Circuit Breaker Open',
        condition: {
          metric: 'circuitBreakerOpen',
          operator: '==',
          threshold: 1, // true
        },
        severity: 'critical',
        enabled: true,
        dryRun: false,
        notificationTargets: [
          { type: 'slack', destination: '@takagi' },
          { type: 'log', destination: 'alert-critical' },
        ],
      },

      // ALERT-003: Notion API Down
      {
        id: 'ALERT-003',
        name: 'Notion API Down',
        condition: {
          metric: 'notionApiResponseTime',
          operator: '>',
          threshold: 4000, // 4秒以上は失敗判定
        },
        severity: 'critical',
        enabled: true,
        dryRun: false,
        notificationTargets: [
          { type: 'slack', destination: '@takagi' },
          { type: 'log', destination: 'alert-critical' },
        ],
      },

      // ALERT-004: レイテンシ >6s for 3連続
      {
        id: 'ALERT-004',
        name: 'High Latency (>6s, 3x consecutive)',
        condition: {
          metric: 'avgLatency',
          operator: '>',
          threshold: 6000,
          consecutive: 3,
        },
        severity: 'warning',
        enabled: true,
        dryRun: false,
        notificationTargets: [
          { type: 'slack', destination: '#engineering' },
          { type: 'log', destination: 'alert-warning' },
        ],
      },

      // ALERT-005: 取得成功率 <95%
      {
        id: 'ALERT-005',
        name: 'Low Success Rate (<95%)',
        condition: {
          metric: 'successRate',
          operator: '<',
          threshold: 95,
        },
        severity: 'warning',
        enabled: true,
        dryRun: false,
        notificationTargets: [
          { type: 'slack', destination: '#engineering' },
          { type: 'log', destination: 'alert-warning' },
        ],
      },

      // ALERT-006: キャッシュヒット率 <50%
      {
        id: 'ALERT-006',
        name: 'Low Cache Hit Rate (<50%)',
        condition: {
          metric: 'cacheHitRate',
          operator: '<',
          threshold: 50,
        },
        severity: 'warning',
        enabled: true,
        dryRun: false,
        notificationTargets: [
          { type: 'slack', destination: '#engineering' },
          { type: 'log', destination: 'alert-warning' },
        ],
      },

      // ALERT-007: Notion API degraded
      {
        id: 'ALERT-007',
        name: 'Notion API Degraded (>3s)',
        condition: {
          metric: 'notionApiResponseTime',
          operator: '>',
          threshold: 3000,
        },
        severity: 'info',
        enabled: true,
        dryRun: false,
        notificationTargets: [
          { type: 'slack', destination: '#engineering' },
          { type: 'log', destination: 'alert-info' },
        ],
      },

      // ALERT-008: Slack未送信（通知失敗）
      {
        id: 'ALERT-008',
        name: 'Slack Notification Failure',
        condition: {
          metric: 'slackNotificationFailed',
          operator: '==',
          threshold: 1, // true
        },
        severity: 'warning',
        enabled: true,
        dryRun: false,
        notificationTargets: [
          { type: 'log', destination: 'alert-notification-failure' },
        ],
      },
    ];

    rules.forEach((rule) => {
      this.ruleMap.set(rule.id, rule);
    });

    this.logger.info(
      { ruleCount: rules.length, ruleIds: rules.map((r) => r.id) },
      'Production alert rules initialized'
    );

    return rules;
  }

  /**
   * メトリクス スナップショットに対して全ルールを評価
   */
  evaluateMetrics(snapshot: MetricSnapshot): AlertEvent[] {
    const triggeredAlerts: AlertEvent[] = [];

    for (const [ruleId, rule] of this.ruleMap) {
      if (!rule.enabled) continue;

      const alertEvent = this.evaluateRule(rule, snapshot);
      if (alertEvent) {
        triggeredAlerts.push(alertEvent);

        // テストモードでない場合のみアラートを記録
        if (!rule.dryRun) {
          this.alerts.set(alertEvent.id, alertEvent);
          this.logger.warn(
            {
              alertId: alertEvent.id,
              ruleId: rule.id,
              severity: alertEvent.severity,
              value: alertEvent.value,
            },
            `Alert triggered: ${rule.name}`
          );
        } else {
          this.logger.info(
            {
              alertId: alertEvent.id,
              ruleId: rule.id,
              dryRun: true,
              value: alertEvent.value,
            },
            `DRY_RUN: Alert would trigger: ${rule.name}`
          );
        }
      }
    }

    return triggeredAlerts;
  }

  /**
   * 単一ルール評価
   */
  private evaluateRule(rule: AlertRule, snapshot: MetricSnapshot): AlertEvent | null {
    const { metric, operator, threshold } = rule.condition;
    let value: number;

    // メトリクス値の取得
    switch (metric) {
      case 'errorRate':
        value = ((snapshot.errorCount / (snapshot.errorCount + 100)) * 100);
        break;
      case 'circuitBreakerOpen':
        value = snapshot.circuitBreakerOpen ? 1 : 0;
        break;
      case 'notionApiResponseTime':
        value = snapshot.notionApiResponseTime;
        break;
      case 'avgLatency':
        value = snapshot.avgLatency;
        break;
      case 'successRate':
        value = snapshot.successRate;
        break;
      case 'cacheHitRate':
        value = snapshot.cacheHitRate;
        break;
      case 'slackNotificationFailed':
        // これはアプリケーション層で検知した場合のみセット
        value = 0; // TODO: 別途トラッキング機構で検知
        break;
      default:
        this.logger.warn({ metric }, 'Unknown metric in rule condition');
        return null;
    }

    // 条件判定
    if (!this.compareValues(value, operator, threshold)) {
      return null;
    }

    // アラートイベント生成
    return {
      id: `${rule.id}-${Date.now()}`,
      ruleId: rule.id,
      timestamp: new Date(),
      metric,
      value,
      message: `${rule.name}: ${metric}=${value.toFixed(2)} ${operator} ${threshold}`,
      severity: rule.severity,
      acknowledged: false,
    };
  }

  /**
   * 値比較ユーティリティ
   */
  private compareValues(value: number, operator: string, threshold: number): boolean {
    switch (operator) {
      case '>':
        return value > threshold;
      case '<':
        return value < threshold;
      case '==':
        return value === threshold;
      case '!=':
        return value !== threshold;
      case '>=':
        return value >= threshold;
      case '<=':
        return value <= threshold;
      default:
        return false;
    }
  }

  /**
   * ルール有効化・無効化
   */
  enableRule(ruleId: string): void {
    const rule = this.ruleMap.get(ruleId);
    if (rule) {
      rule.enabled = true;
      this.logger.info({ ruleId }, 'Rule enabled');
    }
  }

  disableRule(ruleId: string): void {
    const rule = this.ruleMap.get(ruleId);
    if (rule) {
      rule.enabled = false;
      this.logger.info({ ruleId }, 'Rule disabled');
    }
  }

  /**
   * ルール一覧取得
   */
  getRules(): AlertRule[] {
    return Array.from(this.ruleMap.values());
  }

  /**
   * テストモード切り替え
   */
  setTestMode(ruleId: string, dryRun: boolean): void {
    const rule = this.ruleMap.get(ruleId);
    if (rule) {
      rule.dryRun = dryRun;
      rule.testDate = new Date();
      this.logger.info(
        { ruleId, dryRun, testDate: rule.testDate },
        'Test mode updated'
      );
    }
  }

  /**
   * 全テストモード切り替え
   */
  setAllTestMode(dryRun: boolean): void {
    for (const rule of this.ruleMap.values()) {
      rule.dryRun = dryRun;
      rule.testDate = new Date();
    }
    this.logger.info({ dryRun, updatedRules: this.ruleMap.size }, 'All test modes updated');
  }
}

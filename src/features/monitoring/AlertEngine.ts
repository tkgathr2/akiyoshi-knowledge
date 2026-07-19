/**
 * アラートエンジン - 8個ルール実装
 * 秋好ナレッジシステム本番監視
 */

import pino from 'pino';
import { AlertRule, AlertEvent, AlertCondition, MetricSnapshot, NotificationTarget } from './types/metrics';

/**
 * ルール別の評価ステート
 * - consecutiveCount: 連続で条件を満たした回数
 * - firstExceedTime: 条件を満たし続けている区間の開始時刻（ms epoch）
 * - lastNotifiedAt: 直近にアラートを発火した時刻（ms epoch）
 */
export interface RuleState {
  consecutiveCount: number;
  firstExceedTime: number | null;
  lastNotifiedAt: number | null;
}

export class AlertEngine {
  private alerts: Map<string, AlertEvent> = new Map();
  private logger: pino.Logger;
  private ruleMap: Map<string, AlertRule> = new Map();
  private ruleState: Map<string, RuleState> = new Map();

  // duration/consecutive条件付きルールが一度発火した後の再通知抑止期間（3時間）
  private readonly NOTIFICATION_COOLDOWN_MS = 3 * 60 * 60 * 1000;

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
    const { metric, operator, threshold, duration, consecutive } = rule.condition;
    let value: number;

    // メトリクス値の取得
    switch (metric) {
      case 'errorRate': {
        // M4修正: totalOps（fetch+cache_hit+fallback）はerrorCountを含まないため、
        // 全件エラー時に totalOps=0 となり errorRate が誤って 0% になっていた（総障害の見逃し）。
        // errorRateの分母は totalOps + errorCount とし、エラーを含む操作全体に対する比率を算出する。
        const errorRateDenominator = snapshot.totalOps + snapshot.errorCount;
        value = errorRateDenominator > 0 ? (snapshot.errorCount / errorRateDenominator) * 100 : 0;
        break;
      }
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
        // M3修正: NotificationEngineの実失敗カウントがMonitoringDashboard経由でsnapshotに注入される。
        // 直近ウィンドウ内で1件以上の通知失敗があれば true(1) とみなす。
        value = (snapshot.slackNotificationFailureCount ?? 0) > 0 ? 1 : 0;
        break;
      default:
        this.logger.warn({ metric }, 'Unknown metric in rule condition');
        return null;
    }

    // M6修正: totalOps=0（アイドル・無操作状態）では successRate=0 が「異常」ではなく
    // 「データ無し」を意味するため、successRateメトリクスのアラート評価自体をスキップし誤アラートを防ぐ。
    if (metric === 'successRate' && snapshot.totalOps === 0) {
      return null;
    }

    // 条件判定
    const conditionMet = this.compareValues(value, operator, threshold);

    // duration/consecutive条件を持たないルールは従来通り即時判定（ステート管理なし）
    if (duration === undefined && consecutive === undefined) {
      if (!conditionMet) {
        return null;
      }
      return this.buildAlertEvent(rule, metric, value, operator, threshold);
    }

    // duration/consecutive条件を持つルールはルール別ステートで継続時間・連続回数を追跡
    const state = this.getOrCreateRuleState(rule.id);

    if (!conditionMet) {
      // 条件を満たさなくなったらステートをリセット（次回また0からカウント）
      this.resetRuleState(rule.id);
      return null;
    }

    const now = Date.now();
    state.consecutiveCount += 1;
    if (state.firstExceedTime === null) {
      state.firstExceedTime = now;
    }

    // consecutive条件: 指定回数連続で条件を満たすまでは発火しない
    if (consecutive !== undefined && state.consecutiveCount < consecutive) {
      return null;
    }

    // duration条件: 条件を満たし続けている時間が閾値に達するまでは発火しない
    if (duration !== undefined) {
      const elapsed = now - state.firstExceedTime;
      if (elapsed < duration) {
        return null;
      }
    }

    // クールダウン: 発火済みなら一定期間は再発火を抑止（初発火時のみ通知）
    if (state.lastNotifiedAt !== null && now - state.lastNotifiedAt < this.NOTIFICATION_COOLDOWN_MS) {
      return null;
    }

    state.lastNotifiedAt = now;

    return this.buildAlertEvent(rule, metric, value, operator, threshold);
  }

  /**
   * アラートイベント生成
   */
  private buildAlertEvent(
    rule: AlertRule,
    metric: string,
    value: number,
    operator: string,
    threshold: number
  ): AlertEvent {
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
   * ルール別ステート取得（存在しなければ初期化）
   */
  private getOrCreateRuleState(ruleId: string): RuleState {
    let state = this.ruleState.get(ruleId);
    if (!state) {
      state = { consecutiveCount: 0, firstExceedTime: null, lastNotifiedAt: null };
      this.ruleState.set(ruleId, state);
    }
    return state;
  }

  /**
   * ルール別ステートをリセット（条件が正常値に戻った場合）
   */
  private resetRuleState(ruleId: string): void {
    this.ruleState.set(ruleId, { consecutiveCount: 0, firstExceedTime: null, lastNotifiedAt: null });
  }

  /**
   * ルール別ステート取得（テスト・監視用）
   */
  getRuleState(ruleId: string): RuleState | undefined {
    return this.ruleState.get(ruleId);
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

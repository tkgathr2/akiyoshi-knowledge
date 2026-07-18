/**
 * 通知エンジン - Slack・Email・ログ通知
 * 秋好ナレッジシステム本番運用
 */

import pino from 'pino';
import { AlertEvent, NotificationTarget } from './types/metrics';

export interface NotificationConfig {
  slackWebhookUrl?: string;
  emailSmtpConfig?: {
    host: string;
    port: number;
    auth: { user: string; pass: string };
  };
  dryRun: boolean;
}

export class NotificationEngine {
  private logger: pino.Logger;
  private config: NotificationConfig;
  private notificationHistory: Array<{
    alertId: string;
    target: string;
    timestamp: Date;
    status: 'success' | 'failed';
  }> = [];

  constructor(config: NotificationConfig, logger?: pino.Logger) {
    this.config = config;
    this.logger = logger || pino({ name: 'NotificationEngine' });
  }

  /**
   * アラートイベント通知
   */
  async sendAlert(alert: AlertEvent, targets: NotificationTarget[]): Promise<void> {
    for (const target of targets) {
      try {
        await this.sendNotification(alert, target);
      } catch (error) {
        this.logger.error(
          { alertId: alert.id, target: target.destination, error },
          'Failed to send notification'
        );

        // 失敗を記録
        this.notificationHistory.push({
          alertId: alert.id,
          target: target.destination,
          timestamp: new Date(),
          status: 'failed',
        });
      }
    }
  }

  /**
   * 単一の通知を送信
   * 通知失敗を握り潰し、本処理に伝播させない（fire-and-forget パターン）
   */
  private async sendNotification(alert: AlertEvent, target: NotificationTarget): Promise<void> {
    try {
      switch (target.type) {
        case 'slack':
          await this.sendSlackNotification(alert, target.destination);
          break;
        case 'email':
          await this.sendEmailNotification(alert, target.destination);
          break;
        case 'log':
          this.sendLogNotification(alert, target.destination);
          break;
      }

      // 成功を記録
      this.notificationHistory.push({
        alertId: alert.id,
        target: target.destination,
        timestamp: new Date(),
        status: 'success',
      });
    } catch (error) {
      // 通知失敗を握り潰す（本処理には伝播させない）
      this.logger.error(
        { alertId: alert.id, target: target.destination, error },
        'Notification delivery failed but will not affect alert processing'
      );

      // 失敗を記録（外側の sendAlert catch とは独立）
      this.notificationHistory.push({
        alertId: alert.id,
        target: target.destination,
        timestamp: new Date(),
        status: 'failed',
      });
    }
  }

  /**
   * Slack通知
   */
  private async sendSlackNotification(alert: AlertEvent, destination: string): Promise<void> {
    if (!this.config.slackWebhookUrl) {
      this.logger.warn('Slack webhook not configured');
      return;
    }

    if (this.config.dryRun) {
      this.logger.info(
        { destination, alert: alert.message },
        'DRY_RUN: Would send Slack notification'
      );
      return;
    }

    const colorMap: Record<string, string> = {
      critical: 'danger',
      warning: 'warning',
      info: '#0099FF',
    };

    const payload = {
      channel: destination.startsWith('#') ? destination : undefined,
      username: 'Akiyoshi Monitoring',
      icon_emoji: ':bell:',
      attachments: [
        {
          color: colorMap[alert.severity],
          title: `[${alert.severity.toUpperCase()}] ${alert.message}`,
          fields: [
            {
              title: 'Alert ID',
              value: alert.id,
              short: true,
            },
            {
              title: 'Metric',
              value: alert.metric,
              short: true,
            },
            {
              title: 'Value',
              value: alert.value.toFixed(2),
              short: true,
            },
            {
              title: 'Timestamp',
              value: alert.timestamp.toISOString(),
              short: true,
            },
          ],
          ts: Math.floor(alert.timestamp.getTime() / 1000),
        },
      ],
    };

    try {
      const response = await fetch(this.config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Slack returned ${response.status}: ${response.statusText}`);
      }

      this.logger.info(
        { destination, alertId: alert.id },
        'Slack notification sent'
      );
    } catch (error) {
      this.logger.error(
        { destination, alertId: alert.id, error },
        'Failed to send Slack notification'
      );
      throw error;
    }
  }

  /**
   * Email通知（スタブ実装）
   */
  private async sendEmailNotification(alert: AlertEvent, destination: string): Promise<void> {
    if (this.config.dryRun) {
      this.logger.info(
        { destination, alert: alert.message },
        'DRY_RUN: Would send email notification'
      );
      return;
    }

    // TODO: nodemailer等を使用した実装
    this.logger.warn(
      { destination },
      'Email notification not yet implemented'
    );
  }

  /**
   * ログ通知
   */
  private sendLogNotification(alert: AlertEvent, destination: string): void {
    const logCategory = destination || 'alert';

    this.logger.info(
      {
        alertId: alert.id,
        ruleId: alert.ruleId,
        severity: alert.severity,
        metric: alert.metric,
        value: alert.value,
        logCategory,
      },
      `Alert logged: ${alert.message}`
    );
  }

  /**
   * 日次集計通知（00:00, 12:00 UTC）
   */
  async sendDailyAggregation(aggregation: any): Promise<void> {
    const message = `
Daily Monitoring Summary (${aggregation.date.toISOString()})

Success Rate: ${aggregation.avgSuccessRate.toFixed(2)}%
P95 Latency: ${aggregation.p95Latency.toFixed(0)}ms
Cache Hit Rate: ${aggregation.avgCacheHitRate.toFixed(2)}%
Total Errors: ${aggregation.totalErrors}
Slack Notifications: ${aggregation.totalSlackNotifications}
Fallback Counts: ${aggregation.totalFallbacks}
Circuit Breaker Opens: ${aggregation.circuitBreakerOpenCount}
Notion API Avg Response: ${aggregation.avgNotionApiResponseTime.toFixed(0)}ms
Peak Cache Usage: ${aggregation.peakCacheUtilization.toFixed(2)}%
Alerts Triggered: ${aggregation.alertsTriggered}
    `;

    if (this.config.dryRun) {
      this.logger.info(
        { date: aggregation.date },
        `DRY_RUN: Daily aggregation:\n${message}`
      );
      return;
    }

    try {
      if (this.config.slackWebhookUrl) {
        await fetch(this.config.slackWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: '#engineering',
            username: 'Akiyoshi Monitoring',
            text: message,
          }),
        });
      }

      this.logger.info(
        { date: aggregation.date },
        'Daily aggregation notification sent'
      );
    } catch (error) {
      this.logger.error({ error }, 'Failed to send daily aggregation');
    }
  }

  /**
   * 通知履歴取得
   */
  getNotificationHistory(hoursBack: number = 24) {
    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    return this.notificationHistory.filter((n) => n.timestamp > cutoffTime);
  }

  /**
   * 失敗した通知の統計
   */
  getFailedNotificationStats() {
    const failures = this.notificationHistory.filter((n) => n.status === 'failed');
    const byTarget: Record<string, number> = {};

    for (const failure of failures) {
      byTarget[failure.target] = (byTarget[failure.target] || 0) + 1;
    }

    return {
      totalFailures: failures.length,
      byTarget,
    };
  }
}

/**
 * AlertEngine バグ修正テスト
 * M3: ALERT-008 (slackNotificationFailed) が永久非発火だった不具合の修正
 * M4: errorRate の分母が errorCount を除外しており、全件エラー時に 0% を返していた不具合の修正
 * M6: totalOps=0（アイドル）時に successRate=0 として誤って ALERT-005 を発火していた不具合の修正
 */

import pino from 'pino';
import { AlertEngine } from '../AlertEngine';
import { MetricSnapshot } from '../types/metrics';
import { NotificationEngine } from '../NotificationEngine';

describe('AlertEngine bug fixes (M3/M4/M6)', () => {
  let engine: AlertEngine;
  const logger = pino({ level: 'silent' });

  function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
    return {
      timestamp: new Date(),
      totalOps: 100,
      successRate: 100,
      avgLatency: 100,
      cacheHitRate: 80,
      errorCount: 0,
      slackNotificationCount: 0,
      circuitBreakerOpen: false,
      fallbackCount: 0,
      notionApiResponseTime: 500,
      cacheUtilizationPercent: 10,
      ...overrides,
    };
  }

  beforeEach(() => {
    engine = new AlertEngine(logger);
    engine.initializeProductionRules();
  });

  describe('M3: ALERT-008 slackNotificationFailed', () => {
    it('should not fire when slackNotificationFailureCount is 0/undefined', () => {
      const snapshot = makeSnapshot({ slackNotificationFailureCount: 0 });
      const alerts = engine.evaluateMetrics(snapshot);
      expect(alerts.find((a) => a.ruleId === 'ALERT-008')).toBeUndefined();
    });

    it('should fire when NotificationEngine reports a recent Slack failure via the snapshot', () => {
      const snapshot = makeSnapshot({ slackNotificationFailureCount: 2 });
      const alerts = engine.evaluateMetrics(snapshot);
      const fired = alerts.find((a) => a.ruleId === 'ALERT-008');
      expect(fired).toBeDefined();
      expect(fired?.value).toBe(1);
    });
  });

  describe('M4: errorRate denominator includes errorCount', () => {
    it('reports errorRate=100 (not 0) when every operation errored (totalOps=0, errorCount>0)', () => {
      // ALERT-001 has a 30min duration condition; drive it to first-fire to read the computed value.
      const snapshot = makeSnapshot({ totalOps: 0, errorCount: 10 });
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-07-19T00:00:00Z'));
      try {
        for (let minute = 0; minute < 30; minute++) {
          engine.evaluateMetrics(snapshot);
          jest.advanceTimersByTime(60 * 1000);
        }
        const alerts = engine.evaluateMetrics(snapshot);
        const fired = alerts.find((a) => a.ruleId === 'ALERT-001');
        expect(fired).toBeDefined();
        expect(fired?.value).toBe(100);
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports errorRate=6 when totalOps=94 (success) and errorCount=6 (100 real operations total)', () => {
      const snapshot = makeSnapshot({ totalOps: 94, errorCount: 6 });
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-07-19T00:00:00Z'));
      try {
        for (let minute = 0; minute < 30; minute++) {
          engine.evaluateMetrics(snapshot);
          jest.advanceTimersByTime(60 * 1000);
        }
        const alerts = engine.evaluateMetrics(snapshot);
        const fired = alerts.find((a) => a.ruleId === 'ALERT-001');
        expect(fired?.value).toBe(6);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('M6: successRate alert skipped when idle (totalOps=0)', () => {
    it('should NOT fire ALERT-005 when totalOps=0 even though successRate=0', () => {
      const snapshot = makeSnapshot({ totalOps: 0, successRate: 0 });
      const alerts = engine.evaluateMetrics(snapshot);
      expect(alerts.find((a) => a.ruleId === 'ALERT-005')).toBeUndefined();
    });

    it('should still fire ALERT-005 when there is real traffic and successRate<95', () => {
      const snapshot = makeSnapshot({ totalOps: 100, successRate: 80 });
      const alerts = engine.evaluateMetrics(snapshot);
      expect(alerts.find((a) => a.ruleId === 'ALERT-005')).toBeDefined();
    });
  });
});

describe('NotificationEngine.getRecentFailureCount (M3)', () => {
  const logger = pino({ level: 'silent' });

  it('returns 0 when there are no recorded failures', () => {
    const engine = new NotificationEngine({ dryRun: true }, logger);
    expect(engine.getRecentFailureCount()).toBe(0);
  });

  it('counts failed Slack notifications recorded within the window', async () => {
    // No slackWebhookUrl configured -> sendSlackNotification just warns and returns (no failure recorded).
    // Simulate a failure via the email path throwing is not applicable either (it's a stub that never throws).
    // Instead, exercise the public failure-recording path through a target type that always logs failure
    // when delivery genuinely errors: use an invalid slack config to force a fetch failure.
    const engine = new NotificationEngine(
      { dryRun: false, slackWebhookUrl: 'http://127.0.0.1:1/unreachable' },
      logger
    );

    await engine.sendAlert(
      {
        id: 'test-alert-1',
        ruleId: 'ALERT-008',
        timestamp: new Date(),
        metric: 'slackNotificationFailed',
        value: 1,
        message: 'test',
        severity: 'warning',
        acknowledged: false,
      },
      [{ type: 'slack', destination: '#engineering' }]
    );

    expect(engine.getRecentFailureCount()).toBeGreaterThanOrEqual(1);
  });
});

/**
 * AlertEngine テスト
 * P0-4: duration/consecutive 条件の評価・クールダウン・ステートリセット
 */

import pino from 'pino';
import { AlertEngine } from '../AlertEngine';
import { MetricSnapshot } from '../types/metrics';

describe('AlertEngine', () => {
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
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-18T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('ALERT-001: duration (エラー率 >5% が30分継続)', () => {
    // errorCount=10 -> errorRate = 10/(10+100)*100 ≈ 9.09% > 5%
    const exceeded = makeSnapshot({ errorCount: 10 });

    it('should not fire every minute while duration has not elapsed, fires exactly once at 30 minutes', () => {
      // 0分〜29分: 毎分評価しても発火しない
      for (let minute = 0; minute < 30; minute++) {
        const alerts = engine.evaluateMetrics(exceeded);
        expect(alerts.find((a) => a.ruleId === 'ALERT-001')).toBeUndefined();
        jest.advanceTimersByTime(60 * 1000);
      }

      // 30分継続時点で初めて発火する
      const alertsAt30Min = engine.evaluateMetrics(exceeded);
      const fired = alertsAt30Min.find((a) => a.ruleId === 'ALERT-001');
      expect(fired).toBeDefined();
      expect(fired?.severity).toBe('critical');
    });

    it('should suppress re-notification during cooldown even if still exceeding (not resent every minute)', () => {
      // 30分継続させて初発火させる
      for (let minute = 0; minute < 30; minute++) {
        engine.evaluateMetrics(exceeded);
        jest.advanceTimersByTime(60 * 1000);
      }
      const firstFire = engine.evaluateMetrics(exceeded);
      expect(firstFire.find((a) => a.ruleId === 'ALERT-001')).toBeDefined();

      // クールダウン(3時間)内は、超過が続いても毎分再送されない
      for (let minute = 0; minute < 60; minute++) {
        jest.advanceTimersByTime(60 * 1000);
        const alerts = engine.evaluateMetrics(exceeded);
        expect(alerts.find((a) => a.ruleId === 'ALERT-001')).toBeUndefined();
      }
    });

    it('should reset ruleState (consecutiveCount/firstExceedTime) when error rate returns to normal', () => {
      for (let minute = 0; minute < 10; minute++) {
        engine.evaluateMetrics(exceeded);
        jest.advanceTimersByTime(60 * 1000);
      }

      const stateWhileExceeding = engine.getRuleState('ALERT-001');
      expect(stateWhileExceeding?.consecutiveCount).toBeGreaterThan(0);
      expect(stateWhileExceeding?.firstExceedTime).not.toBeNull();

      // 正常値に戻る
      const normal = makeSnapshot({ errorCount: 0 });
      const alerts = engine.evaluateMetrics(normal);
      expect(alerts.find((a) => a.ruleId === 'ALERT-001')).toBeUndefined();

      const stateAfterReset = engine.getRuleState('ALERT-001');
      expect(stateAfterReset?.consecutiveCount).toBe(0);
      expect(stateAfterReset?.firstExceedTime).toBeNull();
    });
  });

  describe('ALERT-004: consecutive (レイテンシ >6s が3連続)', () => {
    const highLatency = makeSnapshot({ avgLatency: 7000 });
    const normalLatency = makeSnapshot({ avgLatency: 100 });

    it('should not fire on 2 consecutive occurrences', () => {
      engine.evaluateMetrics(highLatency);
      const alerts = engine.evaluateMetrics(highLatency);
      expect(alerts.find((a) => a.ruleId === 'ALERT-004')).toBeUndefined();
    });

    it('should fire on the 3rd consecutive occurrence', () => {
      engine.evaluateMetrics(highLatency);
      engine.evaluateMetrics(highLatency);
      const alerts = engine.evaluateMetrics(highLatency);
      expect(alerts.find((a) => a.ruleId === 'ALERT-004')).toBeDefined();
    });

    it('should reset consecutive count when latency returns to normal', () => {
      engine.evaluateMetrics(highLatency);
      engine.evaluateMetrics(highLatency);
      engine.evaluateMetrics(normalLatency);

      const state = engine.getRuleState('ALERT-004');
      expect(state?.consecutiveCount).toBe(0);

      // カウントが1に戻っているため、次の1回だけでは発火しない
      const alerts = engine.evaluateMetrics(highLatency);
      expect(alerts.find((a) => a.ruleId === 'ALERT-004')).toBeUndefined();
    });
  });

  describe('duration/consecutiveを持たないルール（従来通り即時発火）', () => {
    it('should still fire immediately for ALERT-002 (circuit breaker open, no duration/consecutive)', () => {
      const snapshot = makeSnapshot({ circuitBreakerOpen: true });
      const alerts = engine.evaluateMetrics(snapshot);
      expect(alerts.find((a) => a.ruleId === 'ALERT-002')).toBeDefined();
    });
  });
});

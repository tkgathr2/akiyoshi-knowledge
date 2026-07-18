/**
 * 監視ログシステム - JSON形式統一・自動エクスポート
 * 秋好ナレッジシステム本番運用
 */

import pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';
import { MonitoringLogEntry } from './types/metrics';

export class MonitoringLogger {
  private entries: MonitoringLogEntry[] = [];
  private exportIntervalMs: number = 60 * 60 * 1000; // 1時間
  private retentionDays: number = 30;
  private logDirectory: string;
  private logger: pino.Logger;
  private exportTimer: NodeJS.Timeout | null = null;

  constructor(
    logDir: string = './logs/monitoring',
    logger?: pino.Logger
  ) {
    this.logDirectory = logDir;
    this.logger = logger || pino({ name: 'MonitoringLogger' });

    // ログディレクトリ作成
    this.ensureLogDirectory();

    this.logger.info(
      { logDirectory: this.logDirectory, retentionDays: this.retentionDays },
      'Monitoring logger initialized'
    );
  }

  /**
   * ログエントリ記録
   */
  log(entry: MonitoringLogEntry): void {
    this.entries.push(entry);

    // JSON形式でログ出力
    const jsonEntry = JSON.stringify({
      timestamp: entry.timestamp.toISOString(),
      level: entry.level,
      category: entry.category,
      message: entry.message,
      metadata: entry.metadata,
    });

    // 標準出力にも記録
    switch (entry.level) {
      case 'error':
        this.logger.error(entry.metadata, `[${entry.category}] ${entry.message}`);
        break;
      case 'warn':
        this.logger.warn(entry.metadata, `[${entry.category}] ${entry.message}`);
        break;
      case 'info':
        this.logger.info(entry.metadata, `[${entry.category}] ${entry.message}`);
        break;
      case 'debug':
        this.logger.debug(entry.metadata, `[${entry.category}] ${entry.message}`);
        break;
    }
  }

  /**
   * 便宜メソッド - メトリクスログ
   */
  logMetric(message: string, metadata: Record<string, any>): void {
    this.log({
      timestamp: new Date(),
      level: 'info',
      category: 'metrics',
      message,
      metadata,
    });
  }

  /**
   * 便宜メソッド - アラートログ
   */
  logAlert(severity: string, message: string, metadata: Record<string, any>): void {
    const levelMap: Record<string, 'error' | 'warn' | 'info'> = {
      critical: 'error',
      warning: 'warn',
      info: 'info',
    };

    this.log({
      timestamp: new Date(),
      level: levelMap[severity] || 'info',
      category: 'alert',
      message,
      metadata,
    });
  }

  /**
   * 便宜メソッド - 通知ログ
   */
  logNotification(target: string, status: string, message: string, metadata: Record<string, any>): void {
    this.log({
      timestamp: new Date(),
      level: status === 'success' ? 'info' : 'warn',
      category: 'notification',
      message: `Notification to ${target}: ${message}`,
      metadata: { ...metadata, target, status },
    });
  }

  /**
   * 自動エクスポート開始（1時間ごと）
   */
  startAutoExport(): void {
    if (this.exportTimer) {
      this.logger.warn('Auto export already running');
      return;
    }

    // 初回は5分後、以降は1時間ごと
    this.exportTimer = setTimeout(() => {
      this.exportLogs();
      this.exportTimer = setInterval(() => {
        this.exportLogs();
      }, this.exportIntervalMs);
    }, 5 * 60 * 1000);

    this.logger.info(
      { intervalMs: this.exportIntervalMs },
      'Auto export started'
    );
  }

  /**
   * 自動エクスポート停止
   */
  stopAutoExport(): void {
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
      this.exportTimer = null;
      this.logger.info('Auto export stopped');
    }
  }

  /**
   * ログをJSONファイルにエクスポート
   */
  exportLogs(filename?: string): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5); // "2026-07-18T20-30"
    const exportFilename = filename || `monitoring-${timestamp}.json`;
    const exportPath = path.join(this.logDirectory, exportFilename);

    // JSON形式でエクスポート
    const exportData = {
      exportedAt: now.toISOString(),
      entryCount: this.entries.length,
      entries: this.entries.map((e) => ({
        timestamp: e.timestamp.toISOString(),
        level: e.level,
        category: e.category,
        message: e.message,
        metadata: e.metadata,
      })),
    };

    try {
      fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
      this.logger.info(
        { exportPath, entryCount: this.entries.length },
        'Logs exported'
      );

      // エクスポート後、古いエントリを削除
      this.purgeOldEntries();

      return exportPath;
    } catch (error) {
      this.logger.error(
        { error, exportPath },
        'Failed to export logs'
      );
      throw error;
    }
  }

  /**
   * 古いエントリを削除（30日以上前）
   */
  private purgeOldEntries(): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    const beforeCount = this.entries.length;
    this.entries = this.entries.filter((e) => e.timestamp > cutoffDate);
    const afterCount = this.entries.length;

    if (beforeCount > afterCount) {
      this.logger.info(
        { purgedCount: beforeCount - afterCount, retentionDays: this.retentionDays },
        'Old entries purged'
      );
    }
  }

  /**
   * 古いログファイルを削除（30日以上前）
   */
  purgeOldLogFiles(): void {
    try {
      const files = fs.readdirSync(this.logDirectory);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      let purgedCount = 0;
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(this.logDirectory, file);
        const stats = fs.statSync(filePath);

        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          purgedCount++;
        }
      }

      if (purgedCount > 0) {
        this.logger.info(
          { purgedFileCount: purgedCount, retentionDays: this.retentionDays },
          'Old log files purged'
        );
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to purge old log files');
    }
  }

  /**
   * ディレクトリ作成
   */
  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.logDirectory)) {
      fs.mkdirSync(this.logDirectory, { recursive: true });
    }
  }

  /**
   * 統計情報
   */
  getStatistics() {
    const levels = { info: 0, warn: 0, error: 0, debug: 0 };
    const categories: Record<string, number> = {};

    for (const entry of this.entries) {
      levels[entry.level]++;
      categories[entry.category] = (categories[entry.category] || 0) + 1;
    }

    return {
      totalEntries: this.entries.length,
      levels,
      categories,
      oldestEntry: this.entries[0]?.timestamp,
      newestEntry: this.entries[this.entries.length - 1]?.timestamp,
    };
  }

  /**
   * ログクリア（テスト用）
   */
  clear(): void {
    this.entries = [];
  }
}

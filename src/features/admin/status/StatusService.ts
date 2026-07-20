/**
 * ステータス集計サービス - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * 履歴ストア（CycleHistoryStore）と設定ストア（AdminConfigStore）から
 * 「最終取込時刻・新規動画数・エラー件数・次回実行予定」を組み立てる。
 * 表示ロジックをビューから切り離し、単体テストできるようにするための層。
 */

import { AdminConfigStore } from '../config/AdminConfigStore';
import { CycleHistoryStore } from '../history/CycleHistoryStore';
import { CycleRecord, StatusView } from '../types/admin';

export class StatusService {
  constructor(
    private readonly history: CycleHistoryStore,
    private readonly config: AdminConfigStore
  ) {}

  /**
   * 現在のステータスビューを算出する。
   * 履歴が空なら「未実行」を表す null 値を返す。
   */
  async getStatus(): Promise<StatusView> {
    const [records, cfg] = await Promise.all([this.history.list(1), this.config.load()]);
    const last: CycleRecord | undefined = records[0];

    if (!last) {
      return {
        lastRunAt: null,
        lastNewVideos: 0,
        lastWritten: 0,
        lastErrorCount: 0,
        nextRunAt: null,
        healthy: true,
      };
    }

    // エラー件数 = サイクル自体の失敗(1) + 字幕なし等でスキップした動画数
    const errorCount = (last.error ? 1 : 0) + last.skipped.length;

    // 次回実行予定 = 最終終了時刻 + 巡回間隔（分）。パース不能なら null。
    const finishedMs = Date.parse(last.finishedAt);
    const nextRunAt = Number.isFinite(finishedMs)
      ? new Date(finishedMs + cfg.pollIntervalMinutes * 60_000).toISOString()
      : null;

    return {
      lastRunAt: last.finishedAt,
      lastNewVideos: last.newVideos,
      lastWritten: last.written,
      lastErrorCount: errorCount,
      nextRunAt,
      healthy: !last.error,
    };
  }
}

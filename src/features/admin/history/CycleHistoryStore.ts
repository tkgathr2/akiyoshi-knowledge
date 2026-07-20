/**
 * 取込サイクル履歴ストア - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * 取込 1 サイクルの結果（CycleRecord）を JSON ファイルに新しい順で保持する。
 * デバッグ画面の「直近 5 サイクルのログ」とステータス表示の「最終取込時刻・新規動画数・
 * エラー件数」がこの履歴を読む。ingest 実行のたびに append される。
 *
 * 上限件数（既定 50）を超えた古い記録は捨てる（ファイルの無限肥大を防ぐ）。
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import pino from 'pino';
import { CycleRecord } from '../types/admin';

export class CycleHistoryStore {
  private logger: pino.Logger;

  constructor(
    private readonly filePath: string,
    private readonly maxRecords = 50,
    logger?: pino.Logger
  ) {
    this.logger = logger || pino({ name: 'CycleHistoryStore' });
  }

  /**
   * 履歴を新しい順で読み出す。ファイル無し／破損時は空配列（例外を投げない）。
   * @param limit 返す最大件数（省略時は全件）
   */
  async list(limit?: number): Promise<CycleRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.error({ filePath: this.filePath }, 'History file is corrupt, treating as empty');
      return [];
    }

    if (!Array.isArray(parsed)) return [];

    // 破損した個別レコードは除外し、新しい順（finishedAt 降順）に整列する。
    const records = parsed
      .filter(isCycleRecord)
      .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));

    return typeof limit === 'number' ? records.slice(0, limit) : records;
  }

  /**
   * 1 サイクルの記録を追記する。maxRecords を超えた古い分は切り捨てる。
   * 書き込みは一時ファイル → rename でアトミックに行う。
   */
  async append(record: CycleRecord): Promise<void> {
    const existing = await this.list();
    // 新しい順の先頭に積み、上限で切る。
    const next = [record, ...existing].slice(0, this.maxRecords);

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);

    this.logger.info(
      { written: record.written, newVideos: record.newVideos, trigger: record.trigger },
      'Cycle record appended'
    );
  }
}

/** 最低限のフィールドを持つ CycleRecord かを判定する（破損レコード除去用） */
function isCycleRecord(value: unknown): value is CycleRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.startedAt === 'string' &&
    typeof r.finishedAt === 'string' &&
    typeof r.fetched === 'number' &&
    typeof r.newVideos === 'number' &&
    typeof r.written === 'number' &&
    Array.isArray(r.skipped)
  );
}

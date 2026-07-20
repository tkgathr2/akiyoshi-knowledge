/**
 * 取込サイクル実行 → 履歴記録 - 秋好ナレッジ YouTube 取込システム
 *
 * YouTubeIngestService を 1 サイクル走らせ、その結果を CycleRecord にして履歴へ追記する。
 * 定期実行（ingest エントリ）と管理画面の手動再実行の両方から呼ばれ、
 * 「履歴に残す形」を 1 箇所に統一する。例外時も失敗を記録して再送出する。
 */

import { YouTubeIngestService } from '../../youtube-ingest/YouTubeIngestService';
import { CycleHistoryStore } from '../history/CycleHistoryStore';
import { CycleRecord } from '../types/admin';

export interface RunIngestCycleDeps {
  service: YouTubeIngestService;
  history: CycleHistoryStore;
  trigger: CycleRecord['trigger'];
}

/**
 * 1 サイクル実行して CycleRecord を返す。
 * 成功・失敗いずれも履歴へ追記する（失敗も運用者が気付けるようにするため）。
 * 手動再実行では失敗を握りつぶさず記録した記録を返す。定期実行では上位で捕捉する。
 */
export async function runIngestCycle(deps: RunIngestCycleDeps): Promise<CycleRecord> {
  const startedAt = new Date().toISOString();

  try {
    const result = await deps.service.run();
    const record: CycleRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      fetched: result.fetched,
      newVideos: result.newVideos,
      written: result.written,
      skipped: result.skipped,
      trigger: deps.trigger,
    };
    await deps.history.append(record);
    return record;
  } catch (error) {
    const record: CycleRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      fetched: 0,
      newVideos: 0,
      written: 0,
      skipped: [],
      error: error instanceof Error ? error.message : String(error),
      trigger: deps.trigger,
    };
    await deps.history.append(record);
    return record;
  }
}

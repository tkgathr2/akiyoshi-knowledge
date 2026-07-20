/**
 * 単体: StatusService - 履歴 + 設定から「最終取込・新規数・エラー数・次回予定」を算出
 */
import { StatusService } from '../status/StatusService';
import { AdminConfigStore } from '../config/AdminConfigStore';
import { CycleHistoryStore } from '../history/CycleHistoryStore';
import { AdminConfig, CycleRecord } from '../types/admin';

function fakeHistory(records: CycleRecord[]): CycleHistoryStore {
  return {
    list: async (limit?: number) => (typeof limit === 'number' ? records.slice(0, limit) : records),
  } as unknown as CycleHistoryStore;
}
function fakeConfig(cfg: Partial<AdminConfig>): AdminConfigStore {
  return {
    load: async () => ({ channelId: '', pollIntervalMinutes: 60, keyPointCount: 7, ...cfg }),
  } as unknown as AdminConfigStore;
}

const baseRecord: CycleRecord = {
  startedAt: '2026-07-20T00:00:00.000Z',
  finishedAt: '2026-07-20T00:05:00.000Z',
  fetched: 3,
  newVideos: 2,
  written: 2,
  skipped: [],
  trigger: 'schedule',
};

describe('StatusService.getStatus', () => {
  it('履歴が空なら未実行（null）を返す', async () => {
    const svc = new StatusService(fakeHistory([]), fakeConfig({}));
    const s = await svc.getStatus();
    expect(s.lastRunAt).toBeNull();
    expect(s.nextRunAt).toBeNull();
    expect(s.lastNewVideos).toBe(0);
    expect(s.healthy).toBe(true);
  });

  it('直近サイクルの値を反映し、次回予定を pollInterval から算出する', async () => {
    const svc = new StatusService(fakeHistory([baseRecord]), fakeConfig({ pollIntervalMinutes: 60 }));
    const s = await svc.getStatus();
    expect(s.lastRunAt).toBe('2026-07-20T00:05:00.000Z');
    expect(s.lastNewVideos).toBe(2);
    expect(s.lastErrorCount).toBe(0);
    // 00:05 + 60分 = 01:05
    expect(s.nextRunAt).toBe('2026-07-20T01:05:00.000Z');
    expect(s.healthy).toBe(true);
  });

  it('エラー件数 = サイクル失敗(1) + スキップ数', async () => {
    const rec: CycleRecord = {
      ...baseRecord,
      error: 'boom',
      skipped: [
        { videoId: 'a', reason: '字幕なし' },
        { videoId: 'b', reason: '短すぎ' },
      ],
    };
    const svc = new StatusService(fakeHistory([rec]), fakeConfig({}));
    const s = await svc.getStatus();
    expect(s.lastErrorCount).toBe(3);
    expect(s.healthy).toBe(false);
  });

  it('finishedAt がパース不能なら nextRunAt は null', async () => {
    const rec: CycleRecord = { ...baseRecord, finishedAt: 'not-a-date' };
    const svc = new StatusService(fakeHistory([rec]), fakeConfig({}));
    const s = await svc.getStatus();
    expect(s.nextRunAt).toBeNull();
  });
});

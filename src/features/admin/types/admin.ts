/**
 * 管理画面 型定義 - 秋好ナレッジ YouTube 取込システム
 *
 * 管理画面（設定 / ステータス / 動画一覧 / デバッグ）が扱うデータ構造を集約する。
 * サーバ・ストア・ビューの各層はここで定義した型のみを介して連携する。
 */

/**
 * 取込の動作設定。設定ページから編集し、JSON ファイルへ永続化する。
 * 取込エントリポイント（ingest）はこの設定を環境変数より優先して読む。
 */
export interface AdminConfig {
  /** 取得対象の YouTube チャンネル ID（UC で始まる 24 文字） */
  channelId: string;

  /** 巡回間隔（分）。次回実行予定の算出と、運用者への目安表示に使う。 */
  pollIntervalMinutes: number;

  /** 1 動画あたりに抽出するキーポイント数（5〜10） */
  keyPointCount: number;

  /** 最終更新時刻（ISO 文字列）。未保存なら undefined。 */
  updatedAt?: string;
}

/** AdminConfig の許容範囲（バリデーションと UI の両方で参照する単一ソース） */
export const CONFIG_LIMITS = {
  pollIntervalMinutes: { min: 15, max: 1440 },
  keyPointCount: { min: 5, max: 10 },
} as const;

/** 設定の既定値（設定ファイルが無い初回起動時に使う） */
export const DEFAULT_CONFIG: AdminConfig = {
  channelId: '',
  pollIntervalMinutes: 360,
  keyPointCount: 7,
};

/**
 * 取込 1 サイクルの記録。ingest 実行のたびに履歴ストアへ追記する。
 * ステータス表示とデバッグ画面の両方がこの記録を読む。
 */
export interface CycleRecord {
  /** サイクル開始時刻（ISO 文字列） */
  startedAt: string;

  /** サイクル終了時刻（ISO 文字列） */
  finishedAt: string;

  /** チャンネルから取得した動画数 */
  fetched: number;

  /** 新規と判定された動画数 */
  newVideos: number;

  /** Notion への書き込みに成功した数 */
  written: number;

  /** スキップ（字幕なし等）した動画とその理由 */
  skipped: Array<{ videoId: string; reason: string }>;

  /** サイクル自体が例外で失敗した場合のメッセージ（成功時は undefined） */
  error?: string;

  /** 実行トリガ: 'schedule'（定期）/ 'manual'（デバッグ画面の再実行） */
  trigger: 'schedule' | 'manual';
}

/** 取込結果（YouTubeIngestService.run の戻り値に対応する軽量な形） */
export interface CycleOutcome {
  fetched: number;
  newVideos: number;
  written: number;
  skipped: Array<{ videoId: string; reason: string }>;
}

/**
 * ステータス表示用の集計ビュー。
 * 「最終取込時刻・新規動画数・エラー件数・次回実行予定」をまとめる。
 */
export interface StatusView {
  /** 直近サイクルの終了時刻（ISO）。履歴が無ければ null。 */
  lastRunAt: string | null;

  /** 直近サイクルの新規動画数 */
  lastNewVideos: number;

  /** 直近サイクルの書き込み成功数 */
  lastWritten: number;

  /** 直近サイクルのエラー件数（サイクル失敗 1 + スキップ件数） */
  lastErrorCount: number;

  /** 次回実行予定（ISO）。lastRunAt + pollIntervalMinutes。履歴が無ければ null。 */
  nextRunAt: string | null;

  /** 直近サイクルが正常終了したか */
  healthy: boolean;
}

/** 動画一覧の 1 行（Notion から取得した取込済み動画） */
export interface VideoView {
  /** Notion page_id */
  id: string;

  /** 動画タイトル */
  title: string;

  /** キーポイント要約（summary から先頭を抜粋） */
  summary: string;

  /** 出典 URL（summary から抽出、無ければ undefined） */
  sourceUrl?: string;

  /** Notion 作成日時（ISO） */
  createdAt: string;
}

/** 動画一覧を供給するソース（テストで差し替え可能にするための境界） */
export interface VideoLister {
  listVideos(limit: number): Promise<VideoView[]>;
}

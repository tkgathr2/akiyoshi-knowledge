/**
 * YouTube 取込型定義 - 秋好ナレッジシステム
 * YouTube から取得した動画と文字起こしのデータ構造
 */

/**
 * YouTube 動画メタデータ
 */
export interface YouTubeVideo {
  /** YouTube 動画 ID（11 文字） */
  videoId: string;

  /** 動画タイトル */
  title: string;

  /** 動画の公開日時 */
  publishedAt: Date;

  /** 動画 URL（https://www.youtube.com/watch?v=...） */
  url: string;
}

/**
 * 文字起こし済みの動画
 */
export interface TranscribedVideo extends YouTubeVideo {
  /** 文字起こし全文 */
  transcript: string;
}

/**
 * 取込 1 サイクルの結果
 */
export interface IngestResult {
  /** チャンネルから取得した動画数 */
  fetched: number;

  /** 未取込（新規）と判定された動画数 */
  newVideos: number;

  /** Notion への書き込みに成功した数 */
  written: number;

  /** 文字起こし取得に失敗してスキップした動画 ID */
  skipped: Array<{ videoId: string; reason: string }>;
}

/**
 * 文字起こし取得クライアント - 秋好ナレッジシステム
 *
 * YouTube 動画の字幕（captions）を取得して 1 本のテキストに連結する。
 *
 * 【設計判断・重要】NotebookLM は公開 API を提供していない（2026-07 時点で
 * Google 公式の API ドキュメントが存在しない）。したがって「NotebookLM へ投げて
 * 文字起こしする」構成は実装できない。YouTube が自前で持つ字幕（自動生成含む）を
 * 取得する方式に置き換えた。字幕が存在しない動画はスキップし、理由を記録する。
 */

import pino from 'pino';
import { YouTubeVideo, TranscribedVideo } from '../types/video';

/**
 * 字幕が取得できなかった場合のエラー
 */
export class TranscriptUnavailableError extends Error {
  constructor(
    public readonly videoId: string,
    reason: string
  ) {
    super(`字幕を取得できません (${videoId}): ${reason}`);
    this.name = 'TranscriptUnavailableError';
  }
}

/** youtube-transcript が返す 1 セグメント */
interface TranscriptSegment {
  text: string;
  duration: number;
  offset: number;
}

/** 依存注入用（テストで差し替える） */
export type TranscriptFetcher = (
  videoId: string,
  config?: { lang?: string }
) => Promise<TranscriptSegment[]>;

export class TranscriptClient {
  private logger: pino.Logger;
  private fetchTranscript: TranscriptFetcher;

  /**
   * @param fetcher 字幕取得関数。省略時は youtube-transcript を遅延ロードする
   * @param preferredLangs 優先する字幕の言語コード（先頭から順に試す）
   */
  constructor(
    fetcher?: TranscriptFetcher,
    private readonly preferredLangs: string[] = ['ja', 'en'],
    logger?: pino.Logger
  ) {
    this.logger = logger || pino({ name: 'TranscriptClient' });
    this.fetchTranscript =
      fetcher ??
      (async (videoId, config) => {
        // 実行時のみ読み込む（テストでは fetcher 注入により未使用）
        const mod = await import('youtube-transcript');
        return mod.YoutubeTranscript.fetchTranscript(videoId, config) as Promise<
          TranscriptSegment[]
        >;
      });
  }

  /**
   * 動画の字幕を取得して文字起こしテキストにする。
   * 優先言語を順に試し、すべて失敗したら言語指定なしで最後の 1 回を試す。
   * @throws TranscriptUnavailableError 字幕が 1 つも取得できなかった場合
   */
  async transcribe(video: YouTubeVideo): Promise<TranscribedVideo> {
    const attempts: string[] = [...this.preferredLangs, ''];
    let lastReason = 'unknown';

    for (const lang of attempts) {
      try {
        const segments = await this.fetchTranscript(
          video.videoId,
          lang ? { lang } : undefined
        );

        const transcript = this.joinSegments(segments);
        if (transcript.length === 0) {
          lastReason = 'empty transcript';
          continue;
        }

        this.logger.info(
          { videoId: video.videoId, lang: lang || 'auto', length: transcript.length },
          'Transcript fetched'
        );

        return { ...video, transcript };
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        this.logger.debug(
          { videoId: video.videoId, lang: lang || 'auto', reason: lastReason },
          'Transcript attempt failed'
        );
      }
    }

    throw new TranscriptUnavailableError(video.videoId, lastReason);
  }

  /**
   * 字幕セグメントを 1 本のテキストへ連結する。
   * HTML エンティティ（&amp;#39; 等）が混ざるためデコードし、空白を正規化する。
   */
  private joinSegments(segments: TranscriptSegment[]): string {
    if (!Array.isArray(segments)) return '';

    return segments
      .map((s) => (typeof s?.text === 'string' ? this.decodeEntities(s.text) : ''))
      .filter((t) => t.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 字幕テキストに含まれる HTML エンティティをデコードする。
   * youtube-transcript は二重エスケープ（&amp;#39;）で返すことがあるため 2 段で処理する。
   */
  private decodeEntities(text: string): string {
    // &amp; を先に戻す。youtube-transcript は "&amp;#39;" のように二重エスケープして
    // 返すため、先に &amp; → & にしないと後段の数値参照 (&#39;) が一致しない。
    return text
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
}

/**
 * YouTube チャンネル RSS クライアント - 秋好ナレッジシステム
 *
 * YouTube が公開している Atom フィードから新着動画を取得する。
 *   https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>
 *
 * 【設計判断】YouTube Data API v3 ではなく RSS を既定にした理由:
 *   - API キーが不要（Google Cloud のプロジェクト・課金・キー管理が丸ごと不要になる）
 *   - クォータ制限がない（Data API は 1 日 10,000 ユニットの上限がある）
 *   - 新着検出に必要な videoId / title / published がすべて含まれている
 * 制約: 最新 15 件しか返らない。6 時間ごとの巡回では十分だが、
 * それ以上遡る必要が出たら YouTubeClient（Data API 版）へ切り替える。
 */

import pino from 'pino';
import { YouTubeVideo } from '../types/video';
import { VideoSource } from './VideoSource';

const FEED_BASE = 'https://www.youtube.com/feeds/videos.xml';

/** YouTube チャンネル ID の形式（UC + 22 文字） */
const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;

export class YouTubeFeedError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(`YouTube feed error (${statusCode}): ${message}`);
    this.name = 'YouTubeFeedError';
  }
}

export class YouTubeFeedClient implements VideoSource {
  private readonly TIMEOUT_MS = 10000;
  private logger: pino.Logger;

  constructor(logger?: pino.Logger) {
    this.logger = logger || pino({ name: 'YouTubeFeedClient' });
  }

  /**
   * チャンネル ID の形式を検証する。
   * 動画 ID（11 文字）を誤ってチャンネル ID として渡す事故を検出するため。
   */
  static isValidChannelId(channelId: string): boolean {
    return CHANNEL_ID_PATTERN.test(channelId);
  }

  /**
   * チャンネルの新着動画を取得する（公開日の新しい順）。
   * @param channelId UC で始まる 24 文字のチャンネル ID
   * @param limit 取得件数（フィードの上限 15 件を超えては返らない）
   */
  async fetchLatestVideos(channelId: string, limit = 10): Promise<YouTubeVideo[]> {
    if (!YouTubeFeedClient.isValidChannelId(channelId)) {
      throw new Error(
        `チャンネル ID の形式が不正です: "${channelId}" ` +
          `(UC で始まる 24 文字が必要。動画 ID を渡していませんか?)`
      );
    }

    const xml = await this.fetchFeed(channelId);
    const videos = this.parseEntries(xml).slice(0, limit);

    this.logger.info({ channelId, count: videos.length }, 'YouTube feed fetched');

    return videos;
  }

  /**
   * Atom フィードを取得する（タイムアウト付き）。
   */
  private async fetchFeed(channelId: string): Promise<string> {
    const url = `${FEED_BASE}?channel_id=${encodeURIComponent(channelId)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new YouTubeFeedError(response.status, body.slice(0, 200));
      }

      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Atom フィードの <entry> を YouTubeVideo[] へ変換する。
   * スキーマが固定（yt:videoId / title / published が必ず入る）なため、
   * XML パーサを追加せず必要なタグだけを抽出している。
   */
  private parseEntries(xml: string): YouTubeVideo[] {
    const videos: YouTubeVideo[] = [];

    // <entry> ... </entry> を 1 件ずつ取り出す
    const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;

    while ((match = entryPattern.exec(xml)) !== null) {
      const entry = match[1];

      const videoId = this.extractTag(entry, 'yt:videoId');
      const title = this.extractTag(entry, 'title');
      const published = this.extractTag(entry, 'published');

      if (!videoId || !title) continue;

      videos.push({
        videoId,
        title: this.decodeEntities(title),
        publishedAt: published ? new Date(published) : new Date(0),
        url: `https://www.youtube.com/watch?v=${videoId}`,
      });
    }

    // フィードは新しい順で来るが、順序に依存しないよう明示的に並べ替える
    return videos.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  }

  /**
   * <tag>中身</tag> の中身を取り出す（最初の 1 件のみ）。
   */
  private extractTag(xml: string, tag: string): string | null {
    const escaped = tag.replace(':', '\\:');
    const pattern = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`);
    const match = xml.match(pattern);
    return match ? match[1].trim() : null;
  }

  /**
   * XML エンティティをデコードする。
   * &amp; を先に戻さないと、二重エスケープされた数値参照が復元できない。
   */
  private decodeEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
}

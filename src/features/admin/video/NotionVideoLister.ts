/**
 * 動画一覧ソース（Notion 実装） - 秋好ナレッジ YouTube 取込システム 管理画面
 *
 * 既存の読み取りクライアント NotionKnowledgeClient を包み、取込済み動画を
 * 管理画面表示用の VideoView[] へ変換する。テストからは VideoLister インタフェース
 * 経由でスタブに差し替えられるよう、本クラスは薄いアダプタに留める。
 */

import pino from 'pino';
import { NotionKnowledgeClient } from '../../akiyoshi-knowledge/clients/NotionKnowledgeClient';
import { KnowledgeEntry } from '../../akiyoshi-knowledge/types/knowledge';
import { VideoLister, VideoView } from '../types/admin';

export class NotionVideoLister implements VideoLister {
  private logger: pino.Logger;

  constructor(
    private readonly client: NotionKnowledgeClient,
    logger?: pino.Logger
  ) {
    this.logger = logger || pino({ name: 'NotionVideoLister' });
  }

  async listVideos(limit: number): Promise<VideoView[]> {
    const entries = await this.client.fetchLatest(limit);
    return entries.map((e) => NotionVideoLister.toView(e));
  }

  /** KnowledgeEntry を表示用 VideoView へ変換する。 */
  static toView(entry: KnowledgeEntry): VideoView {
    return {
      id: entry.id,
      title: entry.title,
      summary: NotionVideoLister.buildKeyPointSummary(entry.summary),
      sourceUrl: entry.sourceUrl ?? NotionVideoLister.extractSourceUrl(entry.summary),
      createdAt: entry.createdAt.toISOString(),
    };
  }

  /**
   * summary から「出典: <URL>」の 1 行目を除いた本文を、要約プレビューとして整える。
   * 取込時の summary は 1 行目が出典 URL・以降が文字起こし冒頭という構造のため、
   * URL 行を落として読みやすい抜粋にする。
   */
  static buildKeyPointSummary(summary: string): string {
    if (!summary) return '';
    const withoutSource = summary.replace(/^出典[:：].*(?:\r?\n)/, '').trim();
    const body = withoutSource || summary.trim();
    const MAX = 240;
    return body.length > MAX ? `${body.slice(0, MAX)}…` : body;
  }

  /** summary 先頭の「出典: <URL>」から URL を取り出す（無ければ undefined）。 */
  static extractSourceUrl(summary: string): string | undefined {
    const match = summary.match(/出典[:：]\s*(https?:\/\/\S+)/);
    return match ? match[1] : undefined;
  }
}

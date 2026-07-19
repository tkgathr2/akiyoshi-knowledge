/**
 * Notion 書き込みクライアント - 秋好ナレッジシステム
 *
 * 文字起こし済みの動画を Notion データベースへ 1 ページとして追加する。
 * 既存の NotionKnowledgeClient（読み取り専用）とは別クラスにして、
 * 読み取りパイプラインへ書き込み権限が混ざらないようにしている。
 */

import { Client } from '@notionhq/client';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';
import pino from 'pino';
import { TranscribedVideo } from '../types/video';

/** Notion rich_text 1 ブロックの上限（Notion API 制約） */
const RICH_TEXT_LIMIT = 2000;

/** 1 リクエストで送れる子ブロック数の上限（Notion API 制約） */
const CHILDREN_LIMIT = 100;

/**
 * 書き込み時に設定する status。
 * 読み取り側（NotionKnowledgeClient）が status='完了' で絞り込むため、
 * ここで '完了' を入れないと取り込んだ動画が読み取りパイプラインに乗らない。
 * 実 DB の status オプションは 未着手 / 進行中 / 完了 の 3 つ。
 */
const INGESTED_STATUS = '完了';

export class NotionKnowledgeWriter {
  private client: Client;
  private logger: pino.Logger;

  constructor(
    apiKey: string,
    private readonly databaseId: string,
    logger?: pino.Logger
  ) {
    this.client = new Client({ auth: apiKey });
    this.logger = logger || pino({ name: 'NotionKnowledgeWriter' });
  }

  /**
   * 既に取り込み済みの動画 URL 一覧を取得する。
   *
   * 動画 URL は各ページ本文の先頭ブロックに書いているのではなく、
   * summary プロパティの先頭行に「出典: <URL>」形式で保存している。
   * これによりスキーマ変更なしで重複判定ができる。
   */
  async fetchIngestedVideoIds(limit = 100): Promise<Set<string>> {
    const ids = new Set<string>();
    let cursor: string | undefined;

    while (ids.size < limit) {
      const response = await this.client.databases.query({
        database_id: this.databaseId,
        page_size: Math.min(100, limit - ids.size),
        start_cursor: cursor,
      });

      for (const page of response.results as Array<Record<string, any>>) {
        const summary = this.extractRichText(page?.properties?.summary);
        const videoId = this.extractVideoId(summary);
        if (videoId) ids.add(videoId);
      }

      if (!response.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }

    this.logger.info({ count: ids.size }, 'Fetched already-ingested video ids');
    return ids;
  }

  /**
   * 文字起こし済み動画を Notion に 1 ページとして書き込む。
   * - title プロパティ = 動画タイトル
   * - summary プロパティ = 「出典: <URL>」＋文字起こしの冒頭（重複判定にも使う）
   * - ページ本文 = 文字起こし全文（2000 字ごとに段落分割）
   */
  async writeVideo(video: TranscribedVideo): Promise<string> {
    const summary = this.buildSummary(video);
    const children = this.buildTranscriptBlocks(video.transcript);

    const response = await this.client.pages.create({
      parent: { database_id: this.databaseId },
      properties: {
        title: {
          title: [{ type: 'text', text: { content: video.title.slice(0, RICH_TEXT_LIMIT) } }],
        },
        summary: {
          rich_text: [{ type: 'text', text: { content: summary } }],
        },
        status: {
          status: { name: INGESTED_STATUS },
        },
      },
      children: children.slice(0, CHILDREN_LIMIT),
    });

    const pageId = (response as { id: string }).id;

    // 100 ブロックを超える分は append で追記する（Notion の 1 リクエスト上限対策）
    for (let i = CHILDREN_LIMIT; i < children.length; i += CHILDREN_LIMIT) {
      await this.client.blocks.children.append({
        block_id: pageId,
        children: children.slice(i, i + CHILDREN_LIMIT),
      });
    }

    this.logger.info(
      { videoId: video.videoId, pageId, blocks: children.length },
      'Notion page created'
    );

    return pageId;
  }

  /**
   * summary プロパティの中身を組み立てる。
   * 1 行目に出典 URL を置くことで、次回実行時の重複判定キーになる。
   */
  private buildSummary(video: TranscribedVideo): string {
    const header = `出典: ${video.url}\n`;
    const body = video.transcript.slice(0, RICH_TEXT_LIMIT - header.length - 3);
    const truncated = video.transcript.length > body.length ? '...' : '';
    return header + body + truncated;
  }

  /**
   * 文字起こし全文を Notion の段落ブロック配列へ変換する。
   * 1 ブロック 2000 字の制約があるため分割する。
   */
  private buildTranscriptBlocks(transcript: string): BlockObjectRequest[] {
    const chunks: string[] = [];
    for (let i = 0; i < transcript.length; i += RICH_TEXT_LIMIT) {
      chunks.push(transcript.slice(i, i + RICH_TEXT_LIMIT));
    }

    return chunks.map(
      (chunk): BlockObjectRequest => ({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: chunk } }],
        },
      })
    );
  }

  /**
   * summary テキストの「出典: https://www.youtube.com/watch?v=<id>」から動画 ID を抜く。
   */
  private extractVideoId(summary: string | null): string | null {
    if (!summary) return null;
    const match = summary.match(/[?&]v=([\w-]{11})/);
    return match ? match[1] : null;
  }

  /**
   * Notion の rich_text プロパティからプレーンテキストを取り出す。
   */
  private extractRichText(prop: any): string | null {
    if (!prop || prop.type !== 'rich_text' || !Array.isArray(prop.rich_text)) return null;
    return prop.rich_text.map((t: any) => t?.plain_text ?? '').join('');
  }
}

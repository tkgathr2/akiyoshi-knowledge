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

/** ページ本文のキーポイント見出し */
const KEYPOINTS_HEADING = 'キーポイント';

export interface NotionKnowledgeWriterOptions {
  /**
   * キーポイントを書き込む Notion プロパティ名（rich_text 型）。
   * 未指定なら「プロパティには書かず、ページ本文にだけ」キーポイントを出す。
   * 実 DB に該当プロパティを追加した場合のみ設定する（未追加の DB に書くと Notion API が 400 を返すため）。
   */
  keypointsProperty?: string;
}

export class NotionKnowledgeWriter {
  private client: Client;
  private logger: pino.Logger;
  private readonly keypointsProperty?: string;

  constructor(
    apiKey: string,
    private readonly databaseId: string,
    logger?: pino.Logger,
    options?: NotionKnowledgeWriterOptions
  ) {
    this.client = new Client({ auth: apiKey });
    this.logger = logger || pino({ name: 'NotionKnowledgeWriter' });
    this.keypointsProperty = options?.keypointsProperty;
  }

  /**
   * 既に取り込み済みの動画を判別するためのキー集合を取得する。
   *
   * 2 種類のキーを集める:
   *   1. 動画 ID  — summary 先頭の「出典: <URL>」から抽出（本機能が書いたページ）
   *   2. 正規化タイトル — title プロパティから生成（人が手で追記したページ）
   *
   * 2 を併用する理由: 本機能の導入前に人手で追記されたページには出典 URL が無く、
   * 動画 ID だけで判定すると同じ動画をもう一度書き込んで重複させてしまうため。
   */
  async fetchIngestedKeys(limit = 200): Promise<Set<string>> {
    const keys = new Set<string>();
    let cursor: string | undefined;
    let scanned = 0;

    while (scanned < limit) {
      const response = await this.client.databases.query({
        database_id: this.databaseId,
        page_size: Math.min(100, limit - scanned),
        start_cursor: cursor,
      });

      for (const page of response.results as Array<Record<string, any>>) {
        scanned += 1;

        const summary = this.extractRichText(page?.properties?.summary);
        const videoId = this.extractVideoId(summary);
        if (videoId) keys.add(videoId);

        const title = this.extractTitle(page?.properties?.title);
        const normalized = NotionKnowledgeWriter.normalizeTitle(title);
        if (normalized) keys.add(normalized);
      }

      if (!response.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }

    this.logger.info({ keys: keys.size, scanned }, 'Fetched already-ingested keys');
    return keys;
  }

  /**
   * タイトルを重複判定用に正規化する。
   * 手動追記ページは「2026-07-18｜<動画タイトル>」のように日付が前置されるため、
   * 日付接頭辞を落とし、記号・空白・全角半角の揺れを吸収してから比較する。
   */
  static normalizeTitle(title: string | null): string | null {
    if (!title) return null;

    const withoutDate = title.replace(/^\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*[｜|]\s*/, '');

    const normalized = withoutDate
      .normalize('NFKC')
      .toLowerCase()
      // 引用符（半角・全角・カーリー）・括弧・区切り記号・空白を除去して表記揺れを吸収する。
      // 手動追記ページは " を、YouTube 側は “ ” を使うなど揺れるため。
      .replace(
        /[\s"'‘’“”「」『』（）()［］[\]【】<>《》｜|/\\,.、。・:;：；!?！？#-]/g,
        ''
      );

    // 短すぎるタイトルは誤一致を招くため鍵にしない
    if (normalized.length < 8) return null;

    return `title:${normalized}`;
  }

  /**
   * 文字起こし済み動画を Notion に 1 ページとして書き込む。
   * - title プロパティ = 動画タイトル
   * - summary プロパティ = 「出典: <URL>」＋文字起こしの冒頭（重複判定にも使う）
   * - keypoints プロパティ = キーポイントを 1 行 1 件で連結（keypointsProperty 設定時のみ）
   * - ページ本文 = 「キーポイント」見出し＋箇条書き（あれば）＋文字起こし全文
   *
   * @param video 文字起こし済み動画
   * @param keypoints 抽出済みキーポイント（省略・空なら本文にキーポイント節を出さない）
   */
  async writeVideo(video: TranscribedVideo, keypoints: string[] = []): Promise<string> {
    const summary = this.buildSummary(video);
    const cleanKeypoints = this.normalizeKeypoints(keypoints);

    // キーポイント節（あれば）→ 文字起こし全文 の順で本文を構成する
    const children: BlockObjectRequest[] = [
      ...this.buildKeypointBlocks(cleanKeypoints),
      ...this.buildTranscriptBlocks(video.transcript),
    ];

    const properties: Record<string, unknown> = {
      title: {
        title: [{ type: 'text', text: { content: video.title.slice(0, RICH_TEXT_LIMIT) } }],
      },
      summary: {
        rich_text: [{ type: 'text', text: { content: summary } }],
      },
      status: {
        status: { name: INGESTED_STATUS },
      },
    };

    // keypoints プロパティは「設定済み かつ 抽出できた」ときだけ書く。
    // 未設定の DB に書くと Notion API が 400 を返すため、既定では書かない。
    if (this.keypointsProperty && cleanKeypoints.length > 0) {
      properties[this.keypointsProperty] = {
        rich_text: [
          {
            type: 'text',
            text: { content: this.buildKeypointsPropertyText(cleanKeypoints) },
          },
        ],
      };
    }

    const response = await this.client.pages.create({
      parent: { database_id: this.databaseId },
      properties: properties as never,
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
      { videoId: video.videoId, pageId, blocks: children.length, keypoints: cleanKeypoints.length },
      'Notion page created'
    );

    return pageId;
  }

  /**
   * キーポイントを正規化する（空要素除去・トリム・200 字上限）。
   */
  private normalizeKeypoints(keypoints: string[]): string[] {
    if (!Array.isArray(keypoints)) return [];
    const out: string[] = [];
    for (const kp of keypoints) {
      if (typeof kp !== 'string') continue;
      const text = kp.trim();
      if (text.length === 0) continue;
      out.push(text.slice(0, RICH_TEXT_LIMIT));
    }
    return out;
  }

  /**
   * キーポイントをページ本文のブロック（見出し＋箇条書き）に変換する。
   * キーポイントが無ければ空配列を返す（本文に節を作らない）。
   */
  private buildKeypointBlocks(keypoints: string[]): BlockObjectRequest[] {
    if (keypoints.length === 0) return [];

    const blocks: BlockObjectRequest[] = [
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: KEYPOINTS_HEADING } }],
        },
      },
    ];

    for (const kp of keypoints) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: kp } }],
        },
      });
    }

    return blocks;
  }

  /**
   * keypoints プロパティ（rich_text）に入れる文字列を作る。
   * 「・要点1\n・要点2 …」形式。2000 字上限に収める。
   */
  private buildKeypointsPropertyText(keypoints: string[]): string {
    const joined = keypoints.map((kp) => `・${kp}`).join('\n');
    return joined.length > RICH_TEXT_LIMIT ? joined.slice(0, RICH_TEXT_LIMIT) : joined;
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
   * summary テキストから動画 ID を抜く。
   * 2 つの書式に対応する:
   *   - 本機能が書く形式  : 「出典: https://www.youtube.com/watch?v=<id>」
   *   - 人が手で書いた形式: 「出典：らんさ〜ずチャンネル（動画ID: <id> / ...）」
   * 後者を拾わないと、導入前に手で追記された動画をもう一度取り込んで重複させる。
   */
  private extractVideoId(summary: string | null): string | null {
    if (!summary) return null;

    const byUrl = summary.match(/[?&]v=([\w-]{11})/);
    if (byUrl) return byUrl[1];

    const byLabel = summary.match(/(?:動画ID|videoId|video_id)\s*[:：]\s*([\w-]{11})/i);
    if (byLabel) return byLabel[1];

    return null;
  }

  /**
   * Notion の title プロパティからプレーンテキストを取り出す。
   */
  private extractTitle(prop: any): string | null {
    if (!prop || prop.type !== 'title' || !Array.isArray(prop.title)) return null;
    const text = prop.title.map((t: any) => t?.plain_text ?? '').join('');
    return text.length > 0 ? text : null;
  }

  /**
   * Notion の rich_text プロパティからプレーンテキストを取り出す。
   */
  private extractRichText(prop: any): string | null {
    if (!prop || prop.type !== 'rich_text' || !Array.isArray(prop.rich_text)) return null;
    return prop.rich_text.map((t: any) => t?.plain_text ?? '').join('');
  }
}

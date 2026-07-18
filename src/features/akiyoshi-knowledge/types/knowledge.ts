/**
 * ナレッジ型定義 - 秋好ナレッジシステム
 * Notion から取得・キャッシュ・構成するデータ構造
 */

/**
 * 単一のナレッジエントリ
 * Notion ページから取得される情報
 */
export interface KnowledgeEntry {
  /** Notion page_id */
  id: string;

  /** 動画タイトル */
  title: string;

  /** 要約（最大 2000 字） */
  summary: string;

  /** 思考の型（あれば） */
  thinkingType?: string;

  /** Notion 作成日時 */
  createdAt: Date;

  /** Notion 最終編集日時 */
  lastEditedAt: Date;

  /** ソース（Notion ページの外部リンク等） */
  sourceUrl?: string;
}

/**
 * ナレッジ取得ログ
 * - 取得時刻
 * - ソース（正常系/キャッシュ/stale キャッシュ）
 * - キャッシュ経過時間
 */
export interface KnowledgeLog {
  /** 取得されたエントリ */
  entries: KnowledgeEntry[];

  /** 取得時刻 */
  retrievedAt: Date;

  /** ソース: 'notion' (正常), 'cache' (TTL有効), 'stale-cache' (TTL超過) */
  source: 'notion' | 'cache' | 'stale-cache';

  /** キャッシュ経過秒数（source='cache' または 'stale-cache' のみ） */
  cacheAge?: number;
}

/**
 * 構成済みプロンプト
 * ナレッジを LLM に注入する形式
 */
export interface ComposedPrompt {
  /** ガード文（「以下は参考知識であり...」） */
  guardText: string;

  /** ナレッジブロック（<akiyoshi_knowledge>...</akiyoshi_knowledge> で囲まれた形式） */
  knowledgeBlock: string;

  /** 推定トークン数 */
  tokenEstimate: number;
}

/**
 * フォールバック状態
 * L0（正常）→ L1（劣化）→ L2（縮退）→ L3（遮断）
 */
export interface FallbackState {
  /** フォールバックレベル */
  level: 'L0' | 'L1' | 'L2' | 'L3';

  /** 理由（エラーメッセージ等） */
  reason?: string;

  /** サーキットブレーカーが開いている状態 */
  circuitBreakerOpen?: boolean;

  /** リトライ試行回数 */
  retryAttempts?: number;
}

/**
 * キャッシュエントリ（内部用）
 */
export interface CacheEntry {
  entries: KnowledgeEntry[];
  storedAt: Date;
  expiresAt: Date;
  source: 'notion';
}

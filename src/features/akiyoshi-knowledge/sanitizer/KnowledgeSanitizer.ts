/**
 * ナレッジサニタイザー - プロンプトインジェクション防御
 * 秋好ナレッジシステム
 *
 * Notion から取得したナレッジ（title・summary）は外部入力とみなし、
 * LLM プロンプトへ注入する前に必ずこのサニタイザーを通す。
 */

import { KnowledgeEntry } from '../types/knowledge';

export class KnowledgeSanitizer {
  /** title + summary 合計の文字数上限 */
  private static readonly MAX_LENGTH = 2000;

  /**
   * プロンプトインジェクションでよく使われるパターン
   * - 指示上書き系（ignore/disregard previous instructions 等）
   * - 疑似システムタグ（<system>, [INST] 等）
   * - ナレッジデリミタなりすまし（<akiyoshi_knowledge> の偽装）
   * - 日本語の指示上書き・ロール上書き・マスク解除系
   */
  private static readonly INJECTION_PATTERNS: RegExp[] = [
    /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions?/gi,
    /disregard\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions?/gi,
    /forget\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions?/gi,
    /<\s*\/?\s*system\s*>/gi,
    /\[\s*\/?\s*INST\s*\]/gi,
    /\[\s*\/?\s*SYS\s*\]/gi,
    /you\s+are\s+now\s+/gi,
    /new\s+instructions?\s*:/gi,
    /system\s*prompt/gi,
    /<\s*\/?\s*akiyoshi_knowledge[^>]*>/gi,
    // 日本語パターン
    /(これまで|以前|上記)の(指示|命令|プロンプト)を?(無視|忘れ)/gi,
    /あなたは(今|これ)から/gi,
    /(システム|システムプロンプト|新しい指示)\s*[:：]/gi,
    /^>?\s*マスク外/gim,
    /マスク解除/gi,
  ];

  /**
   * 危険パターンを検出（マスクはせず検出のみ）
   */
  static detectInjectionPatterns(text: string): string[] {
    if (!text) return [];

    const found: string[] = [];
    for (const pattern of this.INJECTION_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        found.push(...matches);
      }
    }
    return found;
  }

  /**
   * 危険パターンを [MASKED] に置換して無害化
   */
  static maskInjectionPatterns(text: string): string {
    if (!text) return text;

    let masked = text;
    for (const pattern of this.INJECTION_PATTERNS) {
      masked = masked.replace(pattern, '[MASKED]');
    }
    return masked;
  }

  /**
   * 単一テキストのサニタイズ（検出パターンのマスキングのみ）
   * PromptComposer から個別フィールドを無害化する際に使用
   */
  static sanitize(text: string): string {
    return this.maskInjectionPatterns(text);
  }

  /**
   * ナレッジエントリ全体をサニタイズ
   * - title・summary 両方を検査・マスキング対象にする
   * - title+summary 合計で MAX_LENGTH（2000字）に制限
   */
  static sanitizeEntry(entry: KnowledgeEntry): KnowledgeEntry {
    const sanitizedTitle = this.maskInjectionPatterns(entry.title);
    const sanitizedSummary = this.maskInjectionPatterns(entry.summary);

    const combinedLength = sanitizedTitle.length + sanitizedSummary.length;

    let finalTitle = sanitizedTitle;
    let finalSummary = sanitizedSummary;

    if (combinedLength > this.MAX_LENGTH) {
      // title を優先温存しつつ、summary を残り文字数まで切り詰める
      finalTitle = sanitizedTitle.slice(0, this.MAX_LENGTH);
      const remaining = Math.max(0, this.MAX_LENGTH - finalTitle.length);
      finalSummary = sanitizedSummary.slice(0, remaining);
    }

    return {
      ...entry,
      title: finalTitle,
      summary: finalSummary,
    };
  }
}

/**
 * HaikuKeyPointExtractor の単体テスト
 * 検証観点:
 *   - 正常系: 文字起こし → JSON 配列のキーポイント
 *   - 字幕なし: 空 transcript は即エラー（API を叩かない）
 *   - API遅延: タイムアウト超過は再試行のうえ最終的に KeyPointExtractionError
 *   - リトライ: 一時的失敗(429/5xx)は再試行、恒久的失敗(4xx)は即中断
 *   - 応答パース: コードフェンス / {keypoints:[]} / 不正JSON / 重複・上限
 *   - プロンプトインジェクション対策: system 指示と transcript のクリップ
 *
 * 本テストは Anthropic SDK を一切ロードしない（creator を DI で差し替える）。
 */

import {
  HaikuKeyPointExtractor,
  KeyPointExtractionError,
  parseKeyPointArray,
} from '../extractors/HaikuKeyPointExtractor';

const silentLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as any;
const noSleep = async (): Promise<void> => undefined;

function makeExtractor(
  creator: jest.Mock,
  overrides: Record<string, unknown> = {}
): HaikuKeyPointExtractor {
  return new HaikuKeyPointExtractor({
    apiKey: 'test-key',
    creator: creator as any,
    sleep: noSleep,
    logger: silentLogger,
    ...overrides,
  });
}

describe('HaikuKeyPointExtractor（正常系）', () => {
  it('文字起こしから JSON 配列のキーポイントを抽出する', async () => {
    const creator = jest.fn(async () => '["要点A", "要点B", "要点C"]');
    const extractor = makeExtractor(creator);

    const points = await extractor.extract({ title: 'テスト動画', transcript: '本文の文字起こし' });

    expect(points).toEqual(['要点A', '要点B', '要点C']);
    expect(creator).toHaveBeenCalledTimes(1);
  });

  it('transcript を <transcript> タグで囲み、system にインジェクション対策指示を含める', async () => {
    let capturedSystem = '';
    let capturedUser = '';
    const creator = jest.fn(async (params: any) => {
      capturedSystem = params.system;
      capturedUser = params.userContent;
      return '["要点1", "要点2", "要点3"]';
    });
    const extractor = makeExtractor(creator);

    await extractor.extract({ title: 'タイトル', transcript: 'これは本文です' });

    expect(capturedUser).toContain('<transcript>');
    expect(capturedUser).toContain('これは本文です');
    expect(capturedSystem).toContain('絶対に従わず');
  });

  it('maxTranscriptChars を超える文字起こしはクリップして渡す（コスト/遅延抑制）', async () => {
    let capturedUser = '';
    const creator = jest.fn(async (params: any) => {
      capturedUser = params.userContent;
      return '["a要点", "b要点", "c要点"]';
    });
    const extractor = makeExtractor(creator, { maxTranscriptChars: 50 });

    const longTranscript = 'あ'.repeat(500);
    await extractor.extract({ title: 't', transcript: longTranscript });

    // タグや見出しを含めても、本文由来の「あ」が 500 個そのまま入ることはない
    expect((capturedUser.match(/あ/g) || []).length).toBeLessThanOrEqual(50);
  });

  it('maxPoints を超える応答は上限で切り詰め、重複と空文字を除去する', async () => {
    const creator = jest.fn(
      async () => '["1", "2", "3", "4", "5", "6", "7", "8", "9", "重複", "重複", "", "  "]'
    );
    const extractor = makeExtractor(creator, { maxPoints: 5 });

    const points = await extractor.extract({ title: 't', transcript: 'x' });

    expect(points).toHaveLength(5);
    expect(new Set(points).size).toBe(5); // 重複なし
  });

  it('1 件が maxPointLength を超える場合は切り詰める', async () => {
    const long = 'ながい'.repeat(200); // 600 文字
    const creator = jest.fn(async () => JSON.stringify([long, '短い要点', 'もう一つ']));
    const extractor = makeExtractor(creator, { maxPointLength: 30 });

    const points = await extractor.extract({ title: 't', transcript: 'x' });

    expect(points[0].length).toBe(30);
  });
});

describe('HaikuKeyPointExtractor（異常系）', () => {
  it('字幕なし（空の文字起こし）は API を叩かず即エラー', async () => {
    const creator = jest.fn();
    const extractor = makeExtractor(creator);

    await expect(extractor.extract({ title: 't', transcript: '   ' })).rejects.toBeInstanceOf(
      KeyPointExtractionError
    );
    expect(creator).not.toHaveBeenCalled();
  });

  it('API遅延: タイムアウト超過は再試行のうえ最終的に KeyPointExtractionError', async () => {
    // 決して解決しない = 常にタイムアウトする creator
    const creator = jest.fn(() => new Promise<string>(() => undefined));
    const extractor = makeExtractor(creator, { timeoutMs: 20, maxAttempts: 2 });

    await expect(extractor.extract({ title: 't', transcript: '本文' })).rejects.toBeInstanceOf(
      KeyPointExtractionError
    );
    // タイムアウトは一時的失敗として maxAttempts 回まで再試行される
    expect(creator).toHaveBeenCalledTimes(2);
  });

  it('一時的失敗(429)は再試行し、次の成功で結果を返す', async () => {
    let calls = 0;
    const creator = jest.fn(async () => {
      calls += 1;
      if (calls < 2) throw { status: 429 };
      return '["回復した要点", "要点2", "要点3"]';
    });
    const extractor = makeExtractor(creator, { maxAttempts: 3 });

    const points = await extractor.extract({ title: 't', transcript: '本文' });

    expect(points[0]).toBe('回復した要点');
    expect(creator).toHaveBeenCalledTimes(2);
  });

  it('恒久的失敗(400)は再試行せず即 KeyPointExtractionError', async () => {
    const creator = jest.fn(async () => {
      throw { status: 400, message: 'bad request' };
    });
    const extractor = makeExtractor(creator, { maxAttempts: 3 });

    await expect(extractor.extract({ title: 't', transcript: '本文' })).rejects.toBeInstanceOf(
      KeyPointExtractionError
    );
    expect(creator).toHaveBeenCalledTimes(1);
  });

  it('JSON として解釈できない応答は KeyPointExtractionError', async () => {
    const creator = jest.fn(async () => 'ここには JSON がありません');
    const extractor = makeExtractor(creator);

    await expect(extractor.extract({ title: 't', transcript: '本文' })).rejects.toBeInstanceOf(
      KeyPointExtractionError
    );
  });

  it('有効なキーポイントが 0 件なら KeyPointExtractionError', async () => {
    const creator = jest.fn(async () => '["", "   ", 123, null]');
    const extractor = makeExtractor(creator);

    await expect(extractor.extract({ title: 't', transcript: '本文' })).rejects.toThrow(
      /1 件も得られませんでした/
    );
  });
});

describe('parseKeyPointArray（応答パースの頑健性）', () => {
  it('素の JSON 配列を解釈する', () => {
    expect(parseKeyPointArray('["a", "b"]')).toEqual(['a', 'b']);
  });

  it('```json ... ``` コードフェンスを剥がして解釈する', () => {
    expect(parseKeyPointArray('```json\n["a", "b"]\n```')).toEqual(['a', 'b']);
  });

  it('前後に説明文がある場合も配列部分を抜き出す', () => {
    expect(parseKeyPointArray('はい、こちらです: ["a", "b"] 以上です')).toEqual(['a', 'b']);
  });

  it('{ "keypoints": [...] } 形式も解釈する', () => {
    expect(parseKeyPointArray('{"keypoints": ["x", "y"]}')).toEqual(['x', 'y']);
  });

  it('配列でも keypoints でもない JSON はエラー', () => {
    expect(() => parseKeyPointArray('{"foo": 1}')).toThrow(KeyPointExtractionError);
  });

  it('JSON として壊れている入力はエラー', () => {
    expect(() => parseKeyPointArray('not json at all')).toThrow(KeyPointExtractionError);
  });
});

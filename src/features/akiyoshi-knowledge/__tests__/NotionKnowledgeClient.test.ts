/**
 * NotionKnowledgeClient テスト
 * UT-101, UT-102 対象
 */

import pino from 'pino';
import { NotionKnowledgeClient } from '../clients/NotionKnowledgeClient';
import { NotionFetchError, TimeoutError } from '../types/errors';

// Notion API をモック化
jest.mock('@notionhq/client');

let mockDatabasesQuery: jest.Mock;

describe('NotionKnowledgeClient', () => {
  let client: NotionKnowledgeClient;
  const testPageId = 'test-page-id';
  const testApiKey = 'test-api-key';
  const logger = pino({ level: 'silent' });

  beforeEach(() => {
    jest.clearAllMocks();

    mockDatabasesQuery = jest.fn();
    const { Client } = require('@notionhq/client');

    (Client as jest.Mock).mockImplementation(
      () => ({
        databases: {
          query: mockDatabasesQuery,
        },
      })
    );

    client = new NotionKnowledgeClient(testApiKey, testPageId, logger);
  });

  describe('UT-101: 正常系', () => {
    it('should fetch latest entries successfully', async () => {
      const mockResponse = {
        results: [
          {
            id: 'page-1',
            created_time: '2026-07-18T10:00:00Z',
            last_edited_time: '2026-07-18T10:00:00Z',
            url: 'https://notion.so/page-1',
            properties: {
              title: {
                type: 'title',
                title: [{ plain_text: 'Entry 1' }],
              },
              summary: {
                type: 'rich_text',
                rich_text: [{ plain_text: 'This is a summary' }],
              },
              status: {
                type: 'status',
                status: { name: 'done' },
              },
            },
          },
        ],
      };

      mockDatabasesQuery.mockResolvedValueOnce(mockResponse);

      const result = await client.fetchLatest(10);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'page-1',
        title: 'Entry 1',
        summary: 'This is a summary',
      });

      expect(mockDatabasesQuery).toHaveBeenCalledTimes(1);
      expect(mockDatabasesQuery).toHaveBeenCalledWith({
        database_id: testPageId,
        page_size: 10,
        sorts: [{ property: 'created_time', direction: 'descending' }],
        filter: {
          property: 'status',
          status: { equals: 'done' },
        },
      });
    });

    it('should fetch 0 entries when database is empty', async () => {
      mockDatabasesQuery.mockResolvedValueOnce({ results: [] });

      const result = await client.fetchLatest(10);

      expect(result).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      mockDatabasesQuery.mockResolvedValueOnce({ results: [] });

      await client.fetchLatest(5);

      expect(mockDatabasesQuery).toHaveBeenCalledWith(
        expect.objectContaining({ page_size: 5 })
      );
    });

    it('should cap limit to 100', async () => {
      mockDatabasesQuery.mockResolvedValueOnce({ results: [] });

      await client.fetchLatest(200);

      expect(mockDatabasesQuery).toHaveBeenCalledWith(
        expect.objectContaining({ page_size: 100 })
      );
    });

    it('should handle missing properties gracefully', async () => {
      const mockResponse = {
        results: [
          {
            id: 'page-2',
            created_time: '2026-07-18T11:00:00Z',
            last_edited_time: '2026-07-18T11:00:00Z',
            properties: {}, // 空のプロパティ
          },
        ],
      };

      mockDatabasesQuery.mockResolvedValueOnce(mockResponse);

      const result = await client.fetchLatest(10);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'page-2',
        title: 'Untitled',
        summary: '',
      });
    });
  });

  describe('UT-102: リトライロジック', () => {
    it('should retry on 429 (rate limit)', async () => {
      mockDatabasesQuery
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockResolvedValueOnce({ results: [] });

      const result = await client.fetchLatest(10);

      expect(result).toEqual([]);
      expect(mockDatabasesQuery).toHaveBeenCalledTimes(3);
    });

    it('should retry on 500', async () => {
      mockDatabasesQuery
        .mockRejectedValueOnce(new Error('500 Internal Server Error'))
        .mockResolvedValueOnce({ results: [] });

      const result = await client.fetchLatest(10);

      expect(result).toEqual([]);
      expect(mockDatabasesQuery).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 401 (unauthorized)', async () => {
      const error = new NotionFetchError(401, 'unauthorized', 'API key invalid');
      mockDatabasesQuery.mockRejectedValueOnce(error);

      await expect(client.fetchLatest(10)).rejects.toThrow(NotionFetchError);
      expect(mockDatabasesQuery).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 403 (forbidden)', async () => {
      const error = new NotionFetchError(403, 'forbidden', 'Access denied');
      mockDatabasesQuery.mockRejectedValueOnce(error);

      await expect(client.fetchLatest(10)).rejects.toThrow(NotionFetchError);
      expect(mockDatabasesQuery).toHaveBeenCalledTimes(1);
    });

    it('should fail after max retries', async () => {
      mockDatabasesQuery
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockRejectedValueOnce(new Error('429 Too Many Requests'));

      await expect(client.fetchLatest(10)).rejects.toThrow();
      expect(mockDatabasesQuery).toHaveBeenCalledTimes(4);
    });

  });


  describe('Token masking', () => {
    it('should mask API token correctly', () => {
      const token = 'notiontokenexample123456';
      const masked = NotionKnowledgeClient.maskToken(token);

      expect(masked).toBe('no****56');
      expect(masked).not.toContain('tokenexample');
    });

    it('should handle short tokens', () => {
      const token = 'ab';
      const masked = NotionKnowledgeClient.maskToken(token);

      expect(masked).toBe('****');
    });
  });
});

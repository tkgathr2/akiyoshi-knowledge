/**
 * エラー型テスト
 */

import {
  NotionFetchError,
  TimeoutError,
  InjectionDetectedError,
  CacheError,
} from '../types/errors';

describe('Error types', () => {
  describe('NotionFetchError', () => {
    it('should create error with all parameters', () => {
      const error = new NotionFetchError(401, 'unauthorized', 'API key invalid');

      expect(error.statusCode).toBe(401);
      expect(error.notionErrorCode).toBe('unauthorized');
      expect(error.message).toBe('API key invalid');
      expect(error.name).toBe('NotionFetchError');
    });

    it('should create error with default message', () => {
      const error = new NotionFetchError(500);

      expect(error.statusCode).toBe(500);
      expect(error.message).toBe('Notion API error: 500');
    });

    it('should identify structural errors (401)', () => {
      const error = new NotionFetchError(401);

      expect(error.isStructuralError()).toBe(true);
      expect(error.isRetryable()).toBe(false);
    });

    it('should identify structural errors (403)', () => {
      const error = new NotionFetchError(403);

      expect(error.isStructuralError()).toBe(true);
      expect(error.isRetryable()).toBe(false);
    });

    it('should identify retryable errors (429)', () => {
      const error = new NotionFetchError(429);

      expect(error.isStructuralError()).toBe(false);
      expect(error.isRetryable()).toBe(true);
    });

    it('should identify retryable errors (500)', () => {
      const error = new NotionFetchError(500);

      expect(error.isStructuralError()).toBe(false);
      expect(error.isRetryable()).toBe(true);
    });

    it('should not retry on 400', () => {
      const error = new NotionFetchError(400);

      expect(error.isStructuralError()).toBe(false);
      expect(error.isRetryable()).toBe(false);
    });

    it('should maintain instanceof check', () => {
      const error = new NotionFetchError(401);

      expect(error instanceof NotionFetchError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('TimeoutError', () => {
    it('should create timeout error with elapsed and timeout', () => {
      const error = new TimeoutError(4500, 4000);

      expect(error.elapsed).toBe(4500);
      expect(error.timeoutMs).toBe(4000);
      expect(error.message).toBe('Timeout after 4500ms (limit: 4000ms)');
      expect(error.name).toBe('TimeoutError');
    });

    it('should maintain instanceof check', () => {
      const error = new TimeoutError(5000, 4000);

      expect(error instanceof TimeoutError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('InjectionDetectedError', () => {
    it('should create injection error with patterns', () => {
      const patterns = ['<system>', '[INST]', 'ignore instruction'];
      const error = new InjectionDetectedError(patterns);

      expect(error.suspiciousPatterns).toEqual(patterns);
      expect(error.message).toContain('<system>');
      expect(error.message).toContain('[INST]');
      expect(error.name).toBe('InjectionDetectedError');
    });

    it('should handle empty patterns', () => {
      const error = new InjectionDetectedError([]);

      expect(error.suspiciousPatterns).toEqual([]);
      expect(error.message).toContain('Injection patterns detected:');
    });

    it('should maintain instanceof check', () => {
      const error = new InjectionDetectedError(['<system>']);

      expect(error instanceof InjectionDetectedError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('CacheError', () => {
    it('should create cache error with message', () => {
      const error = new CacheError('Cache write failed');

      expect(error.message).toBe('Cache write failed');
      expect(error.name).toBe('CacheError');
    });

    it('should maintain instanceof check', () => {
      const error = new CacheError('Test');

      expect(error instanceof CacheError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('Error prototype chain', () => {
    it('should preserve error stack traces', () => {
      const error = new NotionFetchError(500, 'test');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('NotionFetchError');
    });
  });
});

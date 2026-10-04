import { describe, expect, it, vi } from 'vitest';
import { EmbeddingError, OpenAIEmbedder, TopicDetector, type Embedder } from '../../src/topics/detector.ts';
import type { Policy } from '../../src/config/schema.ts';

function policy(chunkChars = 2000): Policy {
  return {
    topic_supervision: { chunk_chars: chunkChars, overlap_chars: 0, default_similarity_threshold: 0.2 },
    topics: {
      hr: { examples: ['employee ranking'], policy_id: 'HR' },
      kyc: { examples: ['customer verification'], policy_id: 'KYC' },
      deal: { examples: ['acquisition analysis'], policy_id: 'DEAL' },
    },
  } as unknown as Policy;
}

describe('topic embeddings', () => {
  it('returns no vectors for empty input without making a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not run'));
    try {
      expect(await new OpenAIEmbedder('test-key', 'text-embedding-3-small').embed([])).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });

  it('restores API response ordering by index and validates vector dimensions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [
      { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
    ] }), { status: 200 }));
    try {
      expect(await new OpenAIEmbedder('test-key', 'text-embedding-3-small').embed(['first', 'second'])).toEqual([[1, 0], [0, 1]]);
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }), { status: 200 }));
      await expect(new OpenAIEmbedder('test-key', 'text-embedding-3-small').embed(['a', 'b'])).rejects.toBeInstanceOf(EmbeddingError);
    } finally { fetchMock.mockRestore(); }
  });

  it('retries initialization after a transient embedding failure', async () => {
    let calls = 0;
    const embedder: Embedder = { name: 'flaky', async embed(texts) {
      calls++;
      if (calls === 1) throw new EmbeddingError('temporary');
      return texts.map(() => [1, 0]);
    } };
    const detector = new TopicDetector(policy(), embedder);
    await expect(detector.detect('a question about the acquisition')).rejects.toThrow('temporary');
    expect(await detector.detect('a question about the acquisition')).toBeDefined();
    expect(calls).toBe(3); // failed init, successful init retry, then query embedding
  });

  it('skips initialization and embedding for blank events', async () => {
    let calls = 0;
    const detector = new TopicDetector(policy(), { name: 'counting', async embed() { calls++; return []; } });
    expect(await detector.detect(' \n\t ')).toEqual([]);
    expect(calls).toBe(0);
  });

  it('keeps vectors for all chunks in a request larger than the cache cap', async () => {
    const embedder: Embedder = { name: 'constant', async embed(texts) { return texts.map(() => [1, 0]); } };
    const detector = new TopicDetector(policy(8), embedder);
    const text = 'x'.repeat(16_100);
    await expect(detector.detect(text)).resolves.toHaveLength(3);
  });
});

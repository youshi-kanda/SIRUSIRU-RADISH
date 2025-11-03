/**
 * SIRUSIRU Radish AI Engine - Utility Functions
 */

import type { Env } from '../types';

interface VectorKnowledge {
  id: number;
  company_id: number;
  source_file: string;
  chunk_text: string;
  embedding: string; // JSON string
  created_at: string;
}

interface VectorSearchResult {
  knowledge: VectorKnowledge;
  score: number;
  rank: number;
}

/**
 * コサイン類似度を計算
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * ベクトル検索を実行（OpenAI Embeddingsを使用）
 */
export async function searchKnowledgeByVector(
  env: Env,
  query: string,
  companyId?: number,
  limit: number = 5
): Promise<VectorSearchResult[]> {
  try {
    // 1. クエリをベクトル化
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: query,
      }),
    });

    if (!embeddingResponse.ok) {
      throw new Error(`OpenAI API error: ${embeddingResponse.status}`);
    }

    const embeddingData: any = await embeddingResponse.json();
    const queryVector: number[] = embeddingData.data[0].embedding;

    // 2. D1から全ベクトルを取得（company_idでフィルタ）
    let stmt;
    if (companyId) {
      stmt = env.DB.prepare('SELECT * FROM knowledge_vectors WHERE company_id = ?');
      stmt = stmt.bind(companyId);
    } else {
      stmt = env.DB.prepare('SELECT * FROM knowledge_vectors');
    }

    const results = await stmt.all<VectorKnowledge>();

    if (!results.results || results.results.length === 0) {
      return [];
    }

    // 3. 各ベクトルとの類似度を計算
    const scoredResults = results.results.map((knowledge) => {
      const knowledgeVector: number[] = JSON.parse(knowledge.embedding);
      const similarity = cosineSimilarity(queryVector, knowledgeVector);
      
      return {
        knowledge,
        score: similarity,
        rank: 0, // 後でソート後に設定
      };
    });

    // 4. 類似度でソート（降順）
    scoredResults.sort((a, b) => b.score - a.score);

    // 5. 上位N件を返す
    const topResults = scoredResults.slice(0, limit);
    
    // ランク付け
    topResults.forEach((result, index) => {
      result.rank = index + 1;
    });

    return topResults;
  } catch (error) {
    console.error('Vector search error:', error);
    return [];
  }
}

/**
 * FTS5を使用したフォールバック検索（ベクトル検索が使えない場合）
 */
export async function searchKnowledgeByText(
  env: Env,
  query: string,
  companyId?: number,
  limit: number = 5
): Promise<VectorSearchResult[]> {
  try {
    let stmt;
    if (companyId) {
      stmt = env.DB.prepare(`
        SELECT kv.* 
        FROM knowledge_vectors kv
        INNER JOIN knowledge_fts fts ON kv.id = fts.rowid
        WHERE fts.chunk_text MATCH ? AND kv.company_id = ?
        LIMIT ?
      `);
      stmt = stmt.bind(query, companyId, limit);
    } else {
      stmt = env.DB.prepare(`
        SELECT kv.* 
        FROM knowledge_vectors kv
        INNER JOIN knowledge_fts fts ON kv.id = fts.rowid
        WHERE fts.chunk_text MATCH ?
        LIMIT ?
      `);
      stmt = stmt.bind(query, limit);
    }

    const results = await stmt.all<VectorKnowledge>();

    if (!results.results) {
      return [];
    }

    return results.results.map((knowledge, index) => ({
      knowledge,
      score: 1 - (index * 0.1), // 簡易スコアリング
      rank: index + 1,
    }));
  } catch (error) {
    console.error('Text search error:', error);
    return [];
  }
}

/**
 * 会話履歴を保存
 */
export async function saveConversation(
  env: Env,
  conversationId: string,
  userId: string | null,
  userMessage: string,
  aiResponse: string,
  diseaseDetected: string | null,
  confidenceScore: number,
  sources: string
): Promise<boolean> {
  try {
    const stmt = env.DB.prepare(`
      INSERT INTO conversations (
        conversation_id, user_id, user_message, ai_response,
        disease_detected, confidence_score, sources
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    await stmt
      .bind(
        conversationId,
        userId,
        userMessage,
        aiResponse,
        diseaseDetected,
        confidenceScore,
        sources
      )
      .run();

    return true;
  } catch (error) {
    console.error('Save conversation error:', error);
    return false;
  }
}

/**
 * KVキャッシュから取得
 */
export async function getFromCache(
  env: Env,
  key: string
): Promise<string | null> {
  try {
    return await env.CACHE.get(key);
  } catch (error) {
    console.error('Cache get error:', error);
    return null;
  }
}

/**
 * KVキャッシュに保存（TTL: 1時間）
 */
export async function setToCache(
  env: Env,
  key: string,
  value: string,
  ttl: number = 3600
): Promise<boolean> {
  try {
    await env.CACHE.put(key, value, { expirationTtl: ttl });
    return true;
  } catch (error) {
    console.error('Cache set error:', error);
    return false;
  }
}

/**
 * 会話IDを生成
 */
export function generateConversationId(): string {
  return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 信頼度スコアを計算
 * - 完全一致: 1.0
 * - 部分一致: 0.7-0.9
 * - FTS検索結果: 0.3-0.6
 */
export function calculateConfidence(score: number, maxScore: number = 10): number {
  if (score >= 10) return 1.0;
  if (score >= 8) return 0.9;
  if (score >= 5) return 0.7;
  if (score >= 3) return 0.5;
  return 0.3;
}

/**
 * エラーレスポンスを生成
 */
export function createErrorResponse(
  error: string,
  code: string = 'INTERNAL_ERROR',
  details?: string
): Response {
  return new Response(
    JSON.stringify({
      error,
      code,
      details,
      timestamp: new Date().toISOString(),
    }),
    {
      status: code === 'BAD_REQUEST' ? 400 : 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}

/**
 * 成功レスポンスを生成
 */
export function createSuccessResponse(data: any): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

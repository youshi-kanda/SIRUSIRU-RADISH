/**
 * SIRUSIRU Radish AI Engine - Utility Functions
 */

import type { Env, Knowledge, KnowledgeSearchResult } from '../types';

/**
 * D1データベースで全文検索を実行
 */
export async function searchKnowledge(
  env: Env,
  query: string,
  limit: number = 10
): Promise<KnowledgeSearchResult[]> {
  try {
    // FTS5を使用した全文検索
    // スコアリング: タイトル一致=10点、本文一致=5点
    const stmt = env.DB.prepare(`
      SELECT 
        k.*,
        CASE
          WHEN k.disease_name LIKE ? THEN 10
          WHEN k.disease_name LIKE ? THEN 8
          ELSE fts.rank * -1
        END as score
      FROM knowledge k
      INNER JOIN knowledge_fts fts ON k.id = fts.rowid
      WHERE knowledge_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `);

    const exactMatch = query;
    const partialMatch = `%${query}%`;
    const ftsQuery = query.split('').join('* ') + '*'; // ワイルドカード検索

    const results = await stmt
      .bind(exactMatch, partialMatch, ftsQuery, limit)
      .all<Knowledge>();

    if (!results.results) {
      return [];
    }

    return results.results.map((knowledge, index) => ({
      knowledge,
      score: (knowledge as any).score || 0,
      rank: index + 1,
    }));
  } catch (error) {
    console.error('Knowledge search error:', error);
    return [];
  }
}

/**
 * 疾病コードで検索
 */
export async function searchByDiseaseCode(
  env: Env,
  diseaseCode: string
): Promise<Knowledge | null> {
  try {
    const stmt = env.DB.prepare(
      'SELECT * FROM knowledge WHERE disease_code = ? LIMIT 1'
    );
    const result = await stmt.bind(diseaseCode).first<Knowledge>();
    return result;
  } catch (error) {
    console.error('Disease code search error:', error);
    return null;
  }
}

/**
 * 疾病名で複数のコードを検索
 */
export async function searchDiseaseCodesByName(
  env: Env,
  diseaseName: string
): Promise<string[]> {
  try {
    const stmt = env.DB.prepare(
      'SELECT disease_code FROM knowledge WHERE disease_name = ?'
    );
    const results = await stmt.bind(diseaseName).all<{ disease_code: string }>();
    
    if (!results.results) {
      return [];
    }

    return results.results.map((row) => row.disease_code);
  } catch (error) {
    console.error('Disease codes search error:', error);
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

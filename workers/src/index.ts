/**
 * SIRUSIRU Radish AI Engine - Main Workers Entry Point
 * Dify-free implementation with OpenAI GPT-4o-mini
 */

import type { Env, ChatRequest, ChatResponse, Source } from './types';
import {
  searchKnowledge,
  searchDiseaseCodesByName,
  saveConversation,
  generateConversationId,
  calculateConfidence,
  createErrorResponse,
  createSuccessResponse,
} from './utils/database';
import {
  classifyInput,
  generateDiseaseCandidates,
  generateUnderwritingResponse,
  validateResponse,
} from './utils/openai';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle OPTIONS request (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/api/health') {
      return createSuccessResponse({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
      });
    }

    // Chat endpoint
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChatRequest(request, env);
    }

    // Knowledge management endpoints (future implementation)
    if (url.pathname.startsWith('/api/knowledge')) {
      return createErrorResponse('Knowledge API not implemented yet', 'NOT_IMPLEMENTED');
    }

    return createErrorResponse('Not Found', 'NOT_FOUND');
  },
};

/**
 * チャットリクエストを処理
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    // リクエストボディを解析
    const body = await request.json<ChatRequest>();
    const { query, conversation_id, user_id } = body;

    if (!query || query.trim().length === 0) {
      return createErrorResponse('Query is required', 'BAD_REQUEST');
    }

    // 会話IDを生成または使用
    const convId = conversation_id || generateConversationId();

    // ステップ1: ユーザー入力を分類（疾病名 or 症状）
    const classification = await classifyInput(env, query);

    if (classification.type === 'SYMPTOM') {
      // 症状入力の場合: 疾病候補を3つ提示
      return await handleSymptomInput(env, query, convId, user_id || null);
    } else if (classification.type === 'DISEASE') {
      // 疾病名入力の場合: 引受判定を実施
      return await handleDiseaseInput(env, query, convId, user_id || null);
    } else {
      // その他: エラー処理
      return await handleOtherInput(env, query, convId, user_id || null);
    }
  } catch (error) {
    console.error('Chat request error:', error);
    return createErrorResponse(
      'Internal server error',
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : undefined
    );
  }
}

/**
 * 症状入力を処理
 */
async function handleSymptomInput(
  env: Env,
  symptom: string,
  conversationId: string,
  userId: string | null
): Promise<Response> {
  try {
    // AIで疾病候補を生成
    const symptomResponse = await generateDiseaseCandidates(env, symptom);

    const response: ChatResponse = {
      answer: symptomResponse.message,
      conversation_id: conversationId,
      disease_detected: null,
      confidence_score: 0.7,
      sources: [],
      type: 'symptom',
      suggestions: symptomResponse.candidates.map((c) => c.disease_name),
    };

    // 会話履歴を保存
    await saveConversation(
      env,
      conversationId,
      userId,
      symptom,
      symptomResponse.message,
      null,
      0.7,
      JSON.stringify([])
    );

    return createSuccessResponse(response);
  } catch (error) {
    console.error('Symptom handling error:', error);
    return createErrorResponse('Failed to process symptom', 'PROCESSING_ERROR');
  }
}

/**
 * 疾病名入力を処理
 */
async function handleDiseaseInput(
  env: Env,
  diseaseName: string,
  conversationId: string,
  userId: string | null
): Promise<Response> {
  try {
    // ステップ1: ナレッジベースで疾病を検索
    const searchResults = await searchKnowledge(env, diseaseName, 10);

    if (searchResults.length === 0) {
      // 該当なしの場合
      const noResultMessage = `申し訳ございません。「${diseaseName}」に関する情報が見つかりませんでした。\n\n病名を正確にご入力いただくか、症状からお伝えいただくこともできます。`;

      const response: ChatResponse = {
        answer: noResultMessage,
        conversation_id: conversationId,
        disease_detected: diseaseName,
        confidence_score: 0.0,
        sources: [],
        type: 'error',
      };

      await saveConversation(
        env,
        conversationId,
        userId,
        diseaseName,
        noResultMessage,
        diseaseName,
        0.0,
        JSON.stringify([])
      );

      return createSuccessResponse(response);
    }

    // ステップ2: 検索結果をコンテキストとして整形
    const knowledgeContext = searchResults
      .map((result) => result.knowledge.content_full)
      .join('\n\n');

    // ステップ3: OpenAI APIで引受判定回答を生成
    const aiResponse = await generateUnderwritingResponse(env, diseaseName, knowledgeContext);

    // ステップ4: 回答の妥当性を検証
    const isValid = validateResponse(aiResponse, searchResults.length > 0);

    if (!isValid) {
      console.warn('Response validation failed, using fallback');
      // フォールバック: ナレッジベースの情報を直接表示
      const fallbackResponse = formatKnowledgeDirectly(searchResults);
      
      const response: ChatResponse = {
        answer: fallbackResponse,
        conversation_id: conversationId,
        disease_detected: diseaseName,
        confidence_score: calculateConfidence(searchResults[0].score),
        sources: searchResults.slice(0, 3).map(
          (r): Source => ({
            disease_code: r.knowledge.disease_code,
            disease_name: r.knowledge.disease_name,
            condition: r.knowledge.condition,
            score: r.score,
          })
        ),
        type: 'disease',
      };

      await saveConversation(
        env,
        conversationId,
        userId,
        diseaseName,
        fallbackResponse,
        diseaseName,
        response.confidence_score,
        JSON.stringify(response.sources)
      );

      return createSuccessResponse(response);
    }

    // ステップ5: 成功レスポンスを返す
    const confidence = calculateConfidence(searchResults[0].score);

    const response: ChatResponse = {
      answer: aiResponse,
      conversation_id: conversationId,
      disease_detected: diseaseName,
      confidence_score: confidence,
      sources: searchResults.slice(0, 3).map(
        (r): Source => ({
          disease_code: r.knowledge.disease_code,
          disease_name: r.knowledge.disease_name,
          condition: r.knowledge.condition,
          score: r.score,
        })
      ),
      type: 'disease',
    };

    // 会話履歴を保存
    await saveConversation(
      env,
      conversationId,
      userId,
      diseaseName,
      aiResponse,
      diseaseName,
      confidence,
      JSON.stringify(response.sources)
    );

    return createSuccessResponse(response);
  } catch (error) {
    console.error('Disease handling error:', error);
    return createErrorResponse('Failed to process disease query', 'PROCESSING_ERROR');
  }
}

/**
 * その他の入力を処理
 */
async function handleOtherInput(
  env: Env,
  query: string,
  conversationId: string,
  userId: string | null
): Promise<Response> {
  const errorMessage = `病名または症状を入力してください。\n\n例:\n・病名: 「胃がん」「糖尿病」「高血圧」\n・症状: 「胃が痛い」「めまいがする」「疲れやすい」`;

  const response: ChatResponse = {
    answer: errorMessage,
    conversation_id: conversationId,
    disease_detected: null,
    confidence_score: 0.0,
    sources: [],
    type: 'error',
  };

  await saveConversation(
    env,
    conversationId,
    userId,
    query,
    errorMessage,
    null,
    0.0,
    JSON.stringify([])
  );

  return createSuccessResponse(response);
}

/**
 * ナレッジベースの情報を直接フォーマット（フォールバック用）
 */
function formatKnowledgeDirectly(searchResults: any[]): string {
  const topResult = searchResults[0].knowledge;

  return `お問い合わせいただいた内容について、以下のとおり判定されました。

病名： ${topResult.disease_name}
状態： ${topResult.condition || '（記載なし）'}
主契約： ${topResult.main_contract || '（記載なし）'}
医療特約： ${topResult.medical_rider || '（記載なし）'}
がん特約： ${topResult.cancer_rider || '（記載なし）'}
収入保障特約： ${topResult.income_rider || '（記載なし）'}
備考： ${topResult.remarks || '（記載なし）'}

※この判定は、ご提供いただいた情報に基づく暫定的なものです。
※正式な審査には、詳細な医療情報の提出が必要となります。`;
}

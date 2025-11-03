/**
 * SIRUSIRU Radish AI Engine - Main Workers Entry Point
 * Dify-free implementation with OpenAI GPT-4o-mini + Vector Search
 */

import type { Env, ChatRequest, ChatResponse, Source, ResponseOption } from './types';
import {
  searchKnowledgeByVector,
  searchKnowledgeByText,
  saveConversation,
  generateConversationId,
  calculateConfidence,
  createErrorResponse,
  createSuccessResponse,
} from './utils/database';
import { 
  getOrCreateConversation, 
  updateConversationState, 
  getCollectedData,
  determineNextState 
} from './utils/conversation';
import {
  classifyInput,
  generateDiseaseCandidates,
  generateUnderwritingResponse,
  validateResponse,
} from './utils/openai';

/**
 * CORS対応のレスポンスヘッダーを作成
 */
function getCorsHeaders(origin?: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Client, X-Tenant-Domain',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const corsHeaders = getCorsHeaders(origin);

    // Handle OPTIONS request (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);

      // Health check endpoint
      if (url.pathname === '/api/health') {
        return new Response(
          JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              ...corsHeaders,
            },
          }
        );
      }

      // Chat endpoint
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const response = await handleChatRequest(request, env);
        // Add CORS headers to response
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      // Django JWT Token endpoint (proxy)
      if (url.pathname === '/api/token/' && request.method === 'POST') {
        const response = await handleDjangoTokenProxy(request, env);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      // Django JWT Token Refresh endpoint (proxy)
      if (url.pathname === '/api/token/refresh/' && request.method === 'POST') {
        const response = await handleDjangoTokenRefreshProxy(request, env);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      // User accessible knowledge bases endpoint
      if (url.pathname === '/api/user/accessible-knowledge-bases' && request.method === 'GET') {
        const response = await handleAccessibleKnowledgeBases(request, env);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      // Token consume endpoint (dummy implementation)
      if (url.pathname === '/app/api/tokens/consume' && request.method === 'POST') {
        const response = await handleTokenConsume(request, env);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }

      return new Response(
        JSON.stringify({ error: 'Not Found', code: 'NOT_FOUND' }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(
        JSON.stringify({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }
  },
};

/**
 * チャットリクエストを処理(状態ベース)
 */
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
  try {
    // リクエストボディを解析
    const body = await request.json<ChatRequest>();
    const { message, query, conversation_id, user_id, selection } = body;
    
    // messageまたはqueryを使用（messageを優先）
    const userInput = message || query;

    // 会話IDを生成または取得
    const convId = conversation_id || generateConversationId();
    const conversation = await getOrCreateConversation(env, convId, user_id || null);
    const collectedData = getCollectedData(conversation);

    // 状態に応じて処理を分岐
    switch (conversation.state) {
      case 'INITIAL':
        return await handleInitialState(env, convId, user_id || null);

      case 'TREATMENT_CHECK':
        return await handleTreatmentCheck(env, convId, selection, userInput);

      case 'DIAGNOSIS_KNOWLEDGE_CHECK':
        return await handleDiagnosisKnowledgeCheck(env, convId, selection, userInput);

      case 'DIAGNOSIS_INPUT':
        return await handleDiagnosisInputState(env, convId, userInput, collectedData);

      case 'SYMPTOM_INPUT':
        return await handleSymptomInputState(env, convId, userInput, collectedData);

      case 'SYMPTOM_FOLLOWUP':
        return await handleSymptomFollowup(env, convId, userInput, collectedData);

      case 'RESULT':
        // 「最終確認へ進む」選択を受け取った場合、FINAL_CONFIRMATIONへ遷移
        if (body.selection === 'proceed') {
          await updateConversationState(env, convId, 'FINAL_CONFIRMATION', {});
          return await handleFinalConfirmation(env, convId, body);
        }
        // 初回RESULT表示
        return await handleResultStateNew(env, convId, collectedData);

      case 'FINAL_CONFIRMATION':
        return await handleFinalConfirmation(env, convId, body);

      case 'COMPLETED':
        return createSuccessResponse({
          answer: 'この問い合わせは完了しました。新しい問い合わせを開始してください。',
          conversation_id: convId,
          state: 'COMPLETED',
          disease_detected: null,
          confidence_score: 0,
          sources: [],
          type: 'error',
        });

      default:
        return createErrorResponse('Invalid conversation state', 'BAD_REQUEST');
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
      options: [
        {
          value: 'proceed',
          label: '最終確認へ進む',
        },
      ],
      requires_input: 'selection',
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
    // ステップ1: ベクトル検索でナレッジベースを検索
    const searchResults = await searchKnowledgeByVector(env, diseaseName, 1, 5);

    if (searchResults.length === 0) {
      // フォールバック: FTS5検索を試行
      const fallbackResults = await searchKnowledgeByText(env, diseaseName, 1, 5);
      
      if (fallbackResults.length === 0) {
        // それでも該当なしの場合
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
      
      // FTS5検索結果からコンテキストを作成
      const knowledgeContext = fallbackResults
        .map((result) => result.knowledge.chunk_text)
        .join('\n\n');
        
      return await generateAndSaveResponse(
        env,
        diseaseName,
        knowledgeContext,
        fallbackResults,
        conversationId,
        userId
      );
    }

    // ステップ2: ベクトル検索結果をコンテキストとして整形
    const knowledgeContext = searchResults
      .map((result) => result.knowledge.chunk_text)
      .join('\n\n');

    return await generateAndSaveResponse(
      env,
      diseaseName,
      knowledgeContext,
      searchResults,
      conversationId,
      userId
    );
  } catch (error) {
    console.error('Disease handling error:', error);
    return createErrorResponse('Failed to process disease query', 'PROCESSING_ERROR');
  }
}

/**
 * AI回答を生成して保存
 */
async function generateAndSaveResponse(
  env: Env,
  diseaseName: string,
  knowledgeContext: string,
  searchResults: any[],
  conversationId: string,
  userId: string | null
): Promise<Response> {
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
      confidence_score: searchResults[0].score,
      sources: searchResults.slice(0, 3).map(
        (r): Source => ({
          source_file: r.knowledge.source_file,
          chunk_text: r.knowledge.chunk_text.substring(0, 100) + '...',
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
  const confidence = searchResults[0].score;

  const response: ChatResponse = {
    answer: aiResponse,
    conversation_id: conversationId,
    disease_detected: diseaseName,
    confidence_score: confidence,
    sources: searchResults.slice(0, 3).map(
      (r): Source => ({
        source_file: r.knowledge.source_file,
        chunk_text: r.knowledge.chunk_text.substring(0, 100) + '...',
        score: r.score,
      })
    ),
    type: 'disease',
    options: [
      {
        value: 'proceed',
        label: '最終確認へ進む',
      },
    ],
    requires_input: 'selection',
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

  return `お問い合わせいただいた内容について、以下の情報が見つかりました。

【検索結果】
${topResult.chunk_text}

※この情報は、ご提供いただいた病名に基づく暫定的なものです。
※正式な審査には、詳細な医療情報の提出が必要となります。

出典: ${topResult.source_file}
類似度スコア: ${(searchResults[0].score * 100).toFixed(1)}%`;
}

// ========================================
// 新しい状態ベースハンドラー関数
// ========================================

/**
 * INITIAL状態: 初回挨拶と5年以内の治療確認
 */
async function handleInitialState(
  env: Env,
  conversationId: string,
  userId: string | null
): Promise<Response> {
  const welcomeMessage = 
    'お電話ありがとうございます。保険加入のご相談を承ります。\n\n' +
    'まず確認させていただきたいのですが、' +
    '**5年以内に治療中、または経過観察中の病気はございますか？**';

  const options: ResponseOption[] = [
    {
      value: 'yes',
      label: 'はい',
    },
    {
      value: 'no',
      label: 'いいえ',
    },
  ];

  // 状態を更新
  await updateConversationState(
    env,
    conversationId,
    'TREATMENT_CHECK',
    {},
    { role: 'assistant', content: welcomeMessage }
  );

  return createSuccessResponse({
    answer: welcomeMessage,
    conversation_id: conversationId,
    state: 'TREATMENT_CHECK',
    disease_detected: null,
    confidence_score: 0,
    sources: [],
    type: 'question',
    options,
    requires_input: 'selection',
  });
}

/**
 * TREATMENT_CHECK状態: 治療有無の選択を処理
 */
async function handleTreatmentCheck(
  env: Env,
  conversationId: string,
  selection: string | undefined,
  userInput: string | undefined
): Promise<Response> {
  if (!selection && !userInput) {
    return createErrorResponse('Selection or input is required', 'BAD_REQUEST');
  }

  // 選択肢を判定
  let treatmentChoice: 'yes' | 'no';
  
  if (selection) {
    treatmentChoice = selection as 'yes' | 'no';
  } else if (userInput) {
    // テキスト入力から推測
    const lower = userInput.toLowerCase();
    if (lower.includes('はい') || lower.includes('ある') || lower.includes('yes')) {
      treatmentChoice = 'yes';
    } else {
      treatmentChoice = 'no';
    }
  } else {
    return createErrorResponse('Invalid selection', 'BAD_REQUEST');
  }

  // データを保存して次の状態へ
  await updateConversationState(
    env,
    conversationId,
    'TREATMENT_CHECK',
    { hasTreatment: treatmentChoice },
    { role: 'user', content: userInput || selection || '' }
  );

  const conversation = await getOrCreateConversation(env, conversationId, null);
  const collectedData = getCollectedData(conversation);
  const nextState = determineNextState('TREATMENT_CHECK', collectedData);

  // 次の状態に応じてレスポンス
  if (nextState === 'DIAGNOSIS_KNOWLEDGE_CHECK') {
    await updateConversationState(env, conversationId, nextState, {});
    
    const options: ResponseOption[] = [
      { value: 'yes', label: 'はい' },
      { value: 'no', label: 'いいえ' },
    ];
    
    return createSuccessResponse({
      answer: '**診断名（病名）をご存知ですか？**',
      conversation_id: conversationId,
      state: nextState,
      disease_detected: null,
      confidence_score: 0,
      sources: [],
      type: 'question',
      options,
      requires_input: 'selection',
    });
  } else if (nextState === 'RESULT') {
    await updateConversationState(env, conversationId, nextState, {});
    return await handleResultStateNew(env, conversationId, collectedData);
  }

  return createErrorResponse('Invalid state transition', 'INTERNAL_ERROR');
}

/**
 * DIAGNOSIS_KNOWLEDGE_CHECK状態: 診断名を知っているか確認
 */
async function handleDiagnosisKnowledgeCheck(
  env: Env,
  conversationId: string,
  selection: string | undefined,
  userInput: string | undefined
): Promise<Response> {
  if (!selection && !userInput) {
    return createErrorResponse('Selection or input is required', 'BAD_REQUEST');
  }

  // 選択肢を判定
  let knowsDiagnosis: boolean;
  
  if (selection) {
    knowsDiagnosis = selection === 'yes';
  } else if (userInput) {
    // テキスト入力から推測
    const lower = userInput.toLowerCase();
    knowsDiagnosis = lower.includes('はい') || lower.includes('知って') || lower.includes('yes');
  } else {
    return createErrorResponse('Invalid selection', 'BAD_REQUEST');
  }

  // データを保存して次の状態へ
  await updateConversationState(
    env,
    conversationId,
    'DIAGNOSIS_KNOWLEDGE_CHECK',
    { knowsDiagnosis },
    { role: 'user', content: userInput || selection || '' }
  );

  const conversation = await getOrCreateConversation(env, conversationId, null);
  const collectedData = getCollectedData(conversation);
  const nextState = determineNextState('DIAGNOSIS_KNOWLEDGE_CHECK', collectedData);

  // 次の状態に応じてレスポンス
  if (nextState === 'DIAGNOSIS_INPUT') {
    await updateConversationState(env, conversationId, nextState, {});
    return createSuccessResponse({
      answer: 'かしこまりました。\n\n**診断名（病名）を教えてください。**\n\n例: 胃炎、糖尿病、高血圧など',
      conversation_id: conversationId,
      state: nextState,
      disease_detected: null,
      confidence_score: 0,
      sources: [],
      type: 'question',
      requires_input: 'text',
    });
  } else if (nextState === 'SYMPTOM_INPUT') {
    await updateConversationState(env, conversationId, nextState, {});
    return createSuccessResponse({
      answer: 'かしこまりました。\n\n**どのような症状がございますか？**\n\n例: 胃が痛い、頭痛がする、めまいがするなど',
      conversation_id: conversationId,
      state: nextState,
      disease_detected: null,
      confidence_score: 0,
      sources: [],
      type: 'question',
      requires_input: 'text',
    });
  }

  return createErrorResponse('Invalid state transition', 'INTERNAL_ERROR');
}

/**
 * DIAGNOSIS_INPUT状態: 診断名入力を処理
 */
async function handleDiagnosisInputState(
  env: Env,
  conversationId: string,
  userInput: string | undefined,
  collectedData: any
): Promise<Response> {
  if (!userInput || userInput.trim().length === 0) {
    return createErrorResponse('診断名を入力してください', 'BAD_REQUEST');
  }

  // 診断名を保存
  await updateConversationState(
    env,
    conversationId,
    'DIAGNOSIS_INPUT',
    { diagnosisName: userInput },
    { role: 'user', content: userInput }
  );

  // 結果状態へ遷移
  const updatedData = { ...collectedData, diagnosisName: userInput };
  const nextState = determineNextState('DIAGNOSIS_INPUT', updatedData);
  await updateConversationState(env, conversationId, nextState, {});

  return await handleResultStateNew(env, conversationId, updatedData);
}

/**
 * SYMPTOM_INPUT状態: 症状入力を処理
 */
async function handleSymptomInputState(
  env: Env,
  conversationId: string,
  userInput: string | undefined,
  collectedData: any
): Promise<Response> {
  if (!userInput || userInput.trim().length === 0) {
    return createErrorResponse('症状を入力してください', 'BAD_REQUEST');
  }

  // 症状を保存
  const symptoms = collectedData.symptoms || [];
  symptoms.push(userInput);

  await updateConversationState(
    env,
    conversationId,
    'SYMPTOM_INPUT',
    { symptoms },
    { role: 'user', content: userInput }
  );

  const updatedData = { ...collectedData, symptoms };
  
  // GPT-4o-miniで疾病候補を生成
  const diseaseCandidates = await generateDiseaseCandidates(env, symptoms.join('、'));
  
  // 診断名候補と保険適応を提示
  let responseText = `症状を確認しました。\n\n**以下の疾病に該当する可能性があります:**\n\n`;
  
  diseaseCandidates.candidates.forEach((candidate, index) => {
    responseText += `${index + 1}. ${candidate.disease_name}\n`;
  });
  
  responseText += `\n---\n\n`;
  
  // 全ての検索結果を保存
  let allResults: any[] = [];
  
  // 各疾病の詳細と保険適応を提示
  for (const candidate of diseaseCandidates.candidates) {
    // ベクトル検索で該当疾病の保険適応情報を取得
    const results = await searchKnowledgeByVector(
      env,
      candidate.disease_name,
      undefined, // company_id
      5 // 上位5件
    );
    
    console.log(`${candidate.disease_name}の検索結果:`, results.length);
    
    responseText += `**${candidate.disease_name}の保険適応:**\n\n`;
    
    if (results.length > 0) {
      // 保険会社ごとに分類
      const insuranceMap = new Map<string, string[]>();
      
      // 各検索結果を処理
      for (const searchResult of results) {
        const knowledge = searchResult.knowledge;
        const companyId = knowledge.company_id;
        const content = knowledge.chunk_text;
        
        // データベースから会社名を取得
        const companyResult = await env.DB.prepare(
          'SELECT company_name FROM insurance_companies WHERE id = ?'
        ).bind(companyId).first<{ company_name: string }>();
        
        const companyName = companyResult?.company_name || `保険会社ID:${companyId}`;
        
        // 内容を150文字に制限
        const summary = content.length > 150 
          ? content.substring(0, 150) + '...' 
          : content;
        
        if (!insuranceMap.has(companyName)) {
          insuranceMap.set(companyName, []);
        }
        insuranceMap.get(companyName)!.push(summary);
        
        // allResultsに変換して追加
        allResults.push({
          content: content,
          score: searchResult.score,
          metadata: {
            company_id: companyId,
            company_name: companyName,
            source_file: knowledge.source_file,
          }
        });
      }
      
      // 保険会社ごとに表示
      insuranceMap.forEach((conditions, company) => {
        responseText += `• **${company}**:\n`;
        conditions.forEach(condition => {
          responseText += `  - ${condition}\n`;
        });
      });
    } else {
      responseText += `該当する保険適応情報が見つかりませんでした。\n`;
    }
    
    responseText += `\n`;
  }
  
  responseText += `最終確認へ進んでよろしいですか？`;
  
  const nextState = 'RESULT';
  await updateConversationState(env, conversationId, nextState, updatedData);

  return createSuccessResponse({
    answer: responseText,
    conversation_id: conversationId,
    state: nextState,
    disease_detected: null,
    confidence_score: 0.7,
    sources: allResults,
    type: 'result',
    options: [
      { value: 'proceed', label: '最終確認へ進む' }
    ],
    requires_input: 'selection',
  });
}

/**
 * SYMPTOM_FOLLOWUP状態: 追加症状入力を処理
 */
async function handleSymptomFollowup(
  env: Env,
  conversationId: string,
  userInput: string | undefined,
  collectedData: any
): Promise<Response> {
  if (!userInput || userInput.trim().length === 0) {
    return createErrorResponse('入力してください', 'BAD_REQUEST');
  }

  // 「なし」でなければ症状を追加
  if (!userInput.includes('なし') && !userInput.toLowerCase().includes('no')) {
    const symptoms = collectedData.symptoms || [];
    symptoms.push(userInput);
    await updateConversationState(
      env,
      conversationId,
      'SYMPTOM_FOLLOWUP',
      { symptoms },
      { role: 'user', content: userInput }
    );
    collectedData.symptoms = symptoms;
  }

  // 結果状態へ遷移
  const nextState = determineNextState('SYMPTOM_FOLLOWUP', collectedData);
  await updateConversationState(env, conversationId, nextState, {});

  return await handleResultStateNew(env, conversationId, collectedData);
}

/**
 * RESULT状態: 判定結果を表示(新実装)
 */
async function handleResultStateNew(
  env: Env,
  conversationId: string,
  collectedData: any
): Promise<Response> {
  // 治療なしの場合
  if (collectedData.hasTreatment === 'no') {
    const answer = 
      '**すべての保険商品にご加入いただけます！**\n\n' +
      '【ご加入可能な保険会社】\n' +
      '・なないろ生命（全商品）\n' +
      '・はなさく生命（全商品）\n' +
      '・ネオファースト生命（全商品）\n\n' +
      '詳しい商品内容や保険料については、担当者よりご案内いたします。';

    return createSuccessResponse({
      answer,
      conversation_id: conversationId,
      state: 'RESULT',
      disease_detected: null,
      confidence_score: 1.0,
      sources: [],
      type: 'result',
      options: [
        {
          value: 'proceed',
          label: '最終確認へ進む',
        },
      ],
      requires_input: 'selection',
    });
  }

  // 診断名がある場合: ベクトル検索
  if (collectedData.diagnosisName) {
    return await handleDiseaseInput(env, collectedData.diagnosisName, conversationId, null);
  }

  // 症状のみの場合: 疾病推定
  if (collectedData.symptoms && collectedData.symptoms.length > 0) {
    const symptomText = collectedData.symptoms.join('、');
    return await handleSymptomInput(env, symptomText, conversationId, null);
  }

  return createErrorResponse('Insufficient data for result', 'BAD_REQUEST');
}

/**
 * FINAL_CONFIRMATION状態: 最終ヒアリング
 */
async function handleFinalConfirmation(
  env: Env,
  conversationId: string,
  body: any
): Promise<Response> {
  // フォームデータを取得
  const formData = body.form_data;

  // フォームデータが未入力の場合、フォーム表示
  if (!formData || !formData.name || !formData.gender || !formData.age) {
    return createSuccessResponse({
      answer: '最後に、お客様情報を入力してください。',
      conversation_id: conversationId,
      state: 'FINAL_CONFIRMATION',
      disease_detected: null,
      confidence_score: 0,
      sources: [],
      type: 'form',
      requires_input: 'form',
      form_fields: [
        {
          name: 'name',
          label: 'お名前',
          type: 'text',
          required: true,
          placeholder: '例: 山田太郎',
        },
        {
          name: 'gender',
          label: '性別',
          type: 'select',
          required: true,
          options: [
            { value: 'male', label: '男性' },
            { value: 'female', label: '女性' },
            { value: 'other', label: 'その他' },
          ],
        },
        {
          name: 'age',
          label: '年齢',
          type: 'number',
          required: true,
          placeholder: '例: 35',
        },
      ],
    });
  }

  // バリデーション
  if (formData.age < 0 || formData.age > 120) {
    return createSuccessResponse({
      answer: '年齢が正しくありません。0〜120の範囲で入力してください。',
      conversation_id: conversationId,
      state: 'FINAL_CONFIRMATION',
      disease_detected: null,
      confidence_score: 0,
      sources: [],
      type: 'error',
      requires_input: 'form',
    });
  }

  // データを保存してCOMPLETED状態に遷移
  await updateConversationState(
    env,
    conversationId,
    'COMPLETED',
    { 
      name: formData.name, 
      gender: formData.gender, 
      age: formData.age 
    },
    { 
      role: 'user', 
      content: `お名前: ${formData.name}, 性別: ${formData.gender}, 年齢: ${formData.age}歳` 
    }
  );

  return createSuccessResponse({
    answer: `✅ **ヒアリング完了**\n\nお名前: ${formData.name}\n性別: ${formData.gender === 'male' ? '男性' : formData.gender === 'female' ? '女性' : 'その他'}\n年齢: ${formData.age}歳\n\n情報を保存しました。次のお問い合わせ対応をお願いします。`,
    conversation_id: conversationId,
    state: 'COMPLETED',
    disease_detected: null,
    confidence_score: 0,
    sources: [],
    type: 'confirmation',
  });
}

// ===================================
// Authentication Handlers
// ===================================

/**
 * Django JWT Token endpoint proxy
 * Django APIの/api/token/エンドポイントへのプロキシ
 */
async function handleDjangoTokenProxy(request: Request, env: Env): Promise<Response> {
  try {
    const djangoApiUrl = 'https://tenant-system.noce-creative.com/api/token/';
    
    // リクエストボディを取得
    const body = await request.text();
    
    // Django APIにプロキシ
    const djangoResponse = await fetch(djangoApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body,
    });
    
    // レスポンスをそのまま返す
    const responseBody = await djangoResponse.text();
    
    return new Response(responseBody, {
      status: djangoResponse.status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Django token proxy error:', error);
    return new Response(
      JSON.stringify({
        error: '認証サーバーへの接続中にエラーが発生しました',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Django JWT Token Refresh endpoint proxy
 * Django APIの/api/token/refresh/エンドポイントへのプロキシ
 */
async function handleDjangoTokenRefreshProxy(request: Request, env: Env): Promise<Response> {
  try {
    const djangoApiUrl = 'https://tenant-system.noce-creative.com/api/token/refresh/';
    
    // リクエストボディを取得
    const body = await request.text();
    
    // Django APIにプロキシ
    const djangoResponse = await fetch(djangoApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body,
    });
    
    // レスポンスをそのまま返す
    const responseBody = await djangoResponse.text();
    
    return new Response(responseBody, {
      status: djangoResponse.status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('Django token refresh proxy error:', error);
    return new Response(
      JSON.stringify({
        error: 'トークン更新サーバーへの接続中にエラーが発生しました',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * ユーザーがアクセス可能なナレッジベース一覧を取得
 */
async function handleAccessibleKnowledgeBases(request: Request, env: Env): Promise<Response> {
  try {
    // 全ユーザーが全ナレッジベースにアクセス可能とする
    // 必要に応じて認証チェックを追加可能
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 1,
            name: "保険引受審査ナレッジベース",
            description: "医療保険の引受審査に関するナレッジベース",
            document_count: 2526,
            created_at: new Date().toISOString()
          }
        ]
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Accessible knowledge bases error:', error);
    return new Response(
      JSON.stringify({ error: 'ナレッジベース一覧取得中にエラーが発生しました' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * トークン消費記録（ダミー実装）
 */
async function handleTokenConsume(request: Request, env: Env): Promise<Response> {
  try {
    // リクエストボディを取得（ログ用）
    const body = await request.json() as { tokens?: number };
    console.log('Token consume request:', body);
    
    // ダミーレスポンスを返す
    return new Response(
      JSON.stringify({
        success: true,
        remaining_tokens: 999999,
        consumed_tokens: body.tokens || 0
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Token consume error:', error);
    return new Response(
      JSON.stringify({ 
        success: false,
        error: 'トークン消費記録中にエラーが発生しました' 
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}



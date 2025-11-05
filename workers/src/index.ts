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

      // Conversation list endpoint
      if (url.pathname === '/api/conversation-list' && request.method === 'GET') {
        const response = await handleConversationList(request, env);
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : '';
      console.error('Error details:', { message: errorMessage, stack: errorStack });
      
      return new Response(
        JSON.stringify({ 
          error: 'Internal Server Error', 
          code: 'INTERNAL_ERROR',
          message: errorMessage,
          timestamp: new Date().toISOString()
        }),
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
    const body = await request.json() as ChatRequest;
    const { message, query, conversation_id, user_id, selection } = body;
    
    // messageまたはqueryを使用（messageを優先）
    const userInput = message || query;
    console.log('[handleChatRequest] User input:', userInput);

    // 会話IDを生成または取得
    const convId = conversation_id || generateConversationId();
    console.log('[handleChatRequest] Conversation ID:', convId);
    
    const conversation = await getOrCreateConversation(env, convId, user_id || null);
    console.log('[handleChatRequest] Current conversation state:', conversation.state);
    
    const collectedData = getCollectedData(conversation);

    // 状態に応じて処理を分岐
    switch (conversation.state) {
      case 'INITIAL':
        // ユーザー入力がない場合のみ初期メッセージを表示
        if (!userInput || userInput.trim() === '') {
          console.log('[INITIAL] No user input, showing welcome message');
          return await handleInitialState(env, convId, user_id || null);
        }
        
        // ユーザー入力がある場合、症状/疾病名を判定
        console.log('[INITIAL] Classifying user input:', userInput);
        const initialClassification = await classifyInput(env, userInput);
        console.log('[INITIAL] Classification result:', initialClassification);
        
        if (initialClassification.type === 'SYMPTOM') {
          // 症状として認識 → 症状入力状態へ
          console.log('[INITIAL] Detected as SYMPTOM, transitioning to SYMPTOM_INPUT');
          await updateConversationState(env, convId, 'SYMPTOM_INPUT', { symptoms: [userInput] });
          return await handleSymptomInputState(env, convId, userInput, { symptoms: [userInput] });
        } else if (initialClassification.type === 'DISEASE') {
          // 疾病名として認識 → 診断名入力状態へ
          console.log('[INITIAL] Detected as DISEASE, transitioning to DIAGNOSIS_INPUT');
          await updateConversationState(env, convId, 'DIAGNOSIS_INPUT', {});
          return await handleDiagnosisInputState(env, convId, userInput, {});
        }
        
        // その他の入力 → 初期状態のまま案内
        console.log('[INITIAL] Detected as OTHER, showing welcome message');
        return await handleInitialState(env, convId, user_id || null);

      case 'TREATMENT_CHECK':
        // ユーザーが症状を直接入力した場合
        if (userInput && !selection) {
          const treatmentClassification = await classifyInput(env, userInput);
          
          if (treatmentClassification.type === 'SYMPTOM') {
            // 症状として認識された場合、症状入力状態へ
            await updateConversationState(env, convId, 'SYMPTOM_INPUT', { symptoms: [userInput], hasTreatment: 'yes' });
            return await handleSymptomInputState(env, convId, userInput, { symptoms: [userInput], hasTreatment: 'yes' });
          } else if (treatmentClassification.type === 'DISEASE') {
            // 疾病名として認識された場合、診断名入力状態へ
            await updateConversationState(env, convId, 'DIAGNOSIS_INPUT', { hasTreatment: 'yes' });
            return await handleDiagnosisInputState(env, convId, userInput, { hasTreatment: 'yes' });
          }
        }
        return await handleTreatmentCheck(env, convId, selection, userInput);

      case 'DIAGNOSIS_KNOWLEDGE_CHECK':
        return await handleDiagnosisKnowledgeCheck(env, convId, selection, userInput);

      case 'DIAGNOSIS_INPUT':
        return await handleDiagnosisInputState(env, convId, userInput, collectedData);

      case 'SYMPTOM_INPUT':
        return await handleSymptomInputState(env, convId, userInput, collectedData);

      case 'DISEASE_SELECTION':
        if (selection === 'edit_symptom') {
          // 症状修正へ
          await updateConversationState(env, convId, 'SYMPTOM_INPUT', {});
          return createSuccessResponse({
            answer: 'かしこまりました。\n\n**症状を修正してください。**\n\n例: 胃が痛い、頭痛がする、めまいがするなど',
            conversation_id: convId,
            state: 'SYMPTOM_INPUT',
            disease_detected: null,
            confidence_score: 0,
            sources: [],
            type: 'question',
            requires_input: 'text',
          });
        } else {
          // 疾病選択
          return await handleDiseaseSelection(env, convId, selection, collectedData);
        }

      case 'DISEASE_DETAIL_VIEW':
        if (selection === 'back_to_list') {
          // 疾病リストに戻る（症状修正オプション付き）
          return await showDiseaseListWithSymptomEdit(env, convId, collectedData);
        } else if (selection === 'proceed') {
          // 最終確認へ
          await updateConversationState(env, convId, 'FINAL_CONFIRMATION', {});
          return await handleFinalConfirmation(env, convId, body);
        }
        // その他のケースは詳細表示を再表示
        return await handleDiseaseDetailView(env, convId, collectedData, collectedData.selectedDisease || '');

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
 * SYMPTOM_INPUT状態: 症状入力を処理（疾病選択式に変更）
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

  try {
    console.log(`[SYMPTOM_INPUT] Processing symptoms for conversation ${conversationId}`);
    
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
    
    console.log(`[SYMPTOM_INPUT] Generating disease candidates...`);
    // GPT-4o-miniで疾病候補を生成
    const diseaseCandidates = await generateDiseaseCandidates(env, symptoms.join('、'));
    console.log(`[SYMPTOM_INPUT] Generated ${diseaseCandidates.candidates.length} candidates`);
    
    // 各疾病の検索結果を事前取得して保存（表示はしない）
    // 🚀 並列処理に変更してパフォーマンス向上
    console.log(`[SYMPTOM_INPUT] Starting parallel vector searches...`);
    const diseaseSearchResults: Array<[string, any[]]> = await Promise.all(
      diseaseCandidates.candidates.map(async (candidate) => {
        try {
          const results = await searchKnowledgeByVector(
            env,
            candidate.disease_name,
            undefined,
            5
          );
          console.log(`${candidate.disease_name}の検索結果: ${results.length}件`);
          return [candidate.disease_name, results] as [string, any[]];
        } catch (error) {
          console.error(`${candidate.disease_name}の検索に失敗:`, error);
          return [candidate.disease_name, []] as [string, any[]];
        }
      })
    );
    console.log(`[SYMPTOM_INPUT] Completed all vector searches`);
    
    // 状態を保存
    await updateConversationState(env, conversationId, 'DISEASE_SELECTION', {
      diseaseCandidates: diseaseCandidates.candidates,
      diseaseSearchResults
    });
    
    // 疾病選択画面を表示
    let responseText = `症状を確認しました。\n\n`;
    responseText += `━━━━━━━━━━━━━━━━━━━━\n`;
    responseText += `**📋 該当する可能性のある疾病**\n`;
    responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    responseText += `以下の疾病が考えられます。\n`;
    responseText += `詳細を確認したい疾病を選択してください。\n`;
    
    // 疾病選択ボタン（横並び） + 症状修正ボタン（縦並び）
    const options = [
      ...diseaseCandidates.candidates.map((c) => ({
        value: c.disease_name,
        label: c.disease_name,
        display: 'inline' as const
      })),
      { value: 'edit_symptom', label: '症状を修正する', display: 'block' as const }
    ];
    
    console.log(`[SYMPTOM_INPUT] Successfully completed, returning response`);
    return createSuccessResponse({
      answer: responseText,
      conversation_id: conversationId,
      state: 'DISEASE_SELECTION',
      disease_detected: null,
      confidence_score: 0.7,
      sources: [],
      type: 'question',
      options,
      requires_input: 'selection',
    });
  } catch (error) {
    console.error('[SYMPTOM_INPUT] Error processing symptoms:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SYMPTOM_INPUT] Error details:', { message: errorMessage });
    
    // エラー時はシンプルなテキスト入力に戻す
    return createErrorResponse(
      `症状の処理中にエラーが発生しました: ${errorMessage}。もう一度お試しください。`,
      'PROCESSING_ERROR'
    );
  }
}

/**
 * DISEASE_SELECTION状態: 疾病選択を処理
 */
async function handleDiseaseSelection(
  env: Env,
  conversationId: string,
  selection: string | undefined,
  collectedData: any
): Promise<Response> {
  if (!selection) {
    return createErrorResponse('疾病を選択してください', 'BAD_REQUEST');
  }
  
  // 選択された疾病を保存
  await updateConversationState(env, conversationId, 'DISEASE_DETAIL_VIEW', {
    selectedDisease: selection
  });
  
  return await handleDiseaseDetailView(env, conversationId, collectedData, selection);
}

/**
 * DISEASE_DETAIL_VIEW状態: 選択された疾病の詳細を表示
 */
async function handleDiseaseDetailView(
  env: Env,
  conversationId: string,
  collectedData: any,
  diseaseName: string
): Promise<Response> {
  // 保存済みの検索結果から該当疾病のデータを取得
  const diseaseSearchResults = collectedData.diseaseSearchResults || [];
  const diseaseEntry = diseaseSearchResults.find(([name, _]: [string, any]) => name === diseaseName);
  const results = diseaseEntry ? diseaseEntry[1] : [];
  
  console.log(`${diseaseName}の検索結果: ${results.length}件`);
  
  let responseText = `━━━━━━━━━━━━━━━━━━━━\n`;
  responseText += `**🏥 ${diseaseName} の保険適応情報**\n`;
  responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  if (results.length > 0) {
    // 保険会社ごとに分類
    const insuranceMap = new Map<string, Array<{content: string, source: string, score: number, canJoin: boolean}>>();
    
    for (const searchResult of results) {
      const knowledge = searchResult.knowledge;
      const companyId = knowledge.company_id;
      const content = knowledge.chunk_text;
      const sourceFile = knowledge.source_file || 'ファイル名不明';
      const score = searchResult.score;
      
      // データベースから会社名を取得
      const companyResult = await env.DB.prepare(
        'SELECT company_name FROM insurance_companies WHERE id = ?'
      ).bind(companyId).first<{ company_name: string }>();
      
      const companyName = companyResult?.company_name || `保険会社ID:${companyId}`;
      
      // 内容を正規化
      let normalizedContent = content
        .replace(/加入可能/g, '○')
        .replace(/加入不可/g, '×')
        .replace(/〇/g, '○');
      
      const canJoin = normalizedContent.includes('○');
      const summary = normalizedContent.length > 200 
        ? normalizedContent.substring(0, 200) + '...' 
        : normalizedContent;
      
      if (!insuranceMap.has(companyName)) {
        insuranceMap.set(companyName, []);
      }
      
      insuranceMap.get(companyName)!.push({
        content: summary,
        source: sourceFile,
        score: score,
        canJoin: canJoin
      });
    }
    
    // 保険会社ごとに表示
    let companyIndex = 0;
    const sortedCompanies = Array.from(insuranceMap.entries()).sort((a, b) => {
      const aHasJoinable = a[1].some(item => item.canJoin);
      const bHasJoinable = b[1].some(item => item.canJoin);
      if (aHasJoinable && !bHasJoinable) return -1;
      if (!aHasJoinable && bHasJoinable) return 1;
      return 0;
    });
    
    sortedCompanies.forEach(([company, items]) => {
      companyIndex++;
      
      const sortedItems = items.sort((a, b) => {
        if (a.canJoin && !b.canJoin) return -1;
        if (!a.canJoin && b.canJoin) return 1;
        return 0;
      });
      
      responseText += `**${String.fromCharCode(65 + companyIndex - 1)}. ${company}**\n\n`;
      sortedItems.forEach((item, idx) => {
        responseText += `${item.content}\n\n`;
        const fileName = item.source.split('/').pop() || item.source;
        const scorePercent = Math.round(item.score * 100);
        responseText += `📎 引用元: ${fileName} (一致度: ${scorePercent}%)\n`;
        responseText += `━━━━━━━━━━━━━━━━\n`;
        if (idx < sortedItems.length - 1) {
          responseText += `\n`;
        }
      });
      
      if (companyIndex < sortedCompanies.length) {
        responseText += `\n`;
      }
    });
  } else {
    responseText += `ℹ️ 該当する保険適応情報が見つかりませんでした。\n\n`;
  }
  
  return createSuccessResponse({
    answer: responseText,
    conversation_id: conversationId,
    state: 'DISEASE_DETAIL_VIEW',
    disease_detected: diseaseName,
    confidence_score: results.length > 0 ? results[0].score : 0,
    sources: results.slice(0, 3).map((r: any) => ({
      source_file: r.knowledge.source_file,
      chunk_text: r.knowledge.chunk_text.substring(0, 100) + '...',
      score: r.score,
    })),
    type: 'result',
    options: [
      { value: 'back_to_list', label: '他の疾病を確認する', display: 'inline' },
      { value: 'proceed', label: '最終確認へ進む', display: 'inline' }
    ],
    requires_input: 'selection',
  });
}

/**
 * 疾病リストを症状修正オプション付きで表示
 */
async function showDiseaseListWithSymptomEdit(
  env: Env,
  conversationId: string,
  collectedData: any
): Promise<Response> {
  const symptoms = collectedData.symptoms || [];
  const diseaseCandidates = collectedData.diseaseCandidates || [];
  
  let responseText = `━━━━━━━━━━━━━━━━━━━━\n`;
  responseText += `**📋 該当する可能性のある疾病**\n`;
  responseText += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  responseText += `現在の症状: ${symptoms.join('、')}\n\n`;
  responseText += `詳細を確認したい疾病を選択してください。\n`;
  
  // 疾病選択ボタン（横並び） + 症状修正ボタン
  const options = [
    ...diseaseCandidates.map((c: any) => ({
      value: c.disease_name,
      label: c.disease_name,
      display: 'inline'
    })),
    { value: 'edit_symptom', label: '症状を修正する', display: 'block' }
  ];
  
  await updateConversationState(env, conversationId, 'DISEASE_SELECTION', {});
  
  return createSuccessResponse({
    answer: responseText,
    conversation_id: conversationId,
    state: 'DISEASE_SELECTION',
    disease_detected: null,
    confidence_score: 0,
    sources: [],
    type: 'question',
    options,
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
  const customerInfo = body.customer_info;

  // フォームデータが未入力の場合、フォーム表示
  if (!customerInfo) {
    return createSuccessResponse({
      answer: '最後に、お客様情報を入力してください。\n※印は必須項目です。',
      conversation_id: conversationId,
      state: 'FINAL_CONFIRMATION',
      disease_detected: null,
      confidence_score: 0,
      sources: [],
      type: 'form',
      requires_input: 'form',
      form_fields: [
        // 基本情報
        {
          name: 'last_name',
          label: '姓 ※',
          type: 'text',
          required: true,
          placeholder: '例: 山田',
        },
        {
          name: 'first_name',
          label: '名 ※',
          type: 'text',
          required: true,
          placeholder: '例: 太郎',
        },
        {
          name: 'last_name_kana',
          label: 'セイ ※',
          type: 'text',
          required: true,
          placeholder: '例: ヤマダ',
        },
        {
          name: 'first_name_kana',
          label: 'メイ ※',
          type: 'text',
          required: true,
          placeholder: '例: タロウ',
        },
        {
          name: 'birth_date',
          label: '生年月日 ※',
          type: 'date',
          required: true,
          placeholder: '例: 1990-01-01',
        },
        {
          name: 'gender',
          label: '性別 ※',
          type: 'select',
          required: true,
          options: [
            { value: 'male', label: '男性' },
            { value: 'female', label: '女性' },
            { value: 'other', label: 'その他' },
          ],
        },
        // 連絡先
        {
          name: 'phone',
          label: '電話番号 ※',
          type: 'tel',
          required: true,
          placeholder: '例: 090-1234-5678',
        },
        {
          name: 'email',
          label: 'メールアドレス ※',
          type: 'email',
          required: true,
          placeholder: '例: example@example.com',
        },
        // 住所（任意）
        {
          name: 'postal_code',
          label: '郵便番号',
          type: 'text',
          required: false,
          placeholder: '例: 123-4567',
        },
        {
          name: 'prefecture',
          label: '都道府県',
          type: 'text',
          required: false,
          placeholder: '例: 東京都',
        },
        {
          name: 'city',
          label: '市区町村',
          type: 'text',
          required: false,
          placeholder: '例: 渋谷区',
        },
        {
          name: 'address',
          label: '番地・建物名',
          type: 'text',
          required: false,
          placeholder: '例: 1-2-3 ABCマンション101',
        },
        // 保険情報
        {
          name: 'desired_coverage_amount',
          label: '希望保険金額（万円） ※',
          type: 'select',
          required: true,
          options: [
            { value: '500', label: '500万円' },
            { value: '1000', label: '1,000万円' },
            { value: '2000', label: '2,000万円' },
            { value: '3000', label: '3,000万円' },
            { value: '5000', label: '5,000万円' },
          ],
        },
        {
          name: 'desired_coverage_period',
          label: '希望保険期間 ※',
          type: 'select',
          required: true,
          options: [
            { value: '10年', label: '10年' },
            { value: '15年', label: '15年' },
            { value: '20年', label: '20年' },
            { value: '終身', label: '終身' },
          ],
        },
        // その他情報
        {
          name: 'smoking_status',
          label: '喫煙状況',
          type: 'select',
          required: false,
          options: [
            { value: 'non_smoker', label: '非喫煙者' },
            { value: 'smoker', label: '喫煙者' },
          ],
        },
        {
          name: 'occupation',
          label: '職業',
          type: 'text',
          required: false,
          placeholder: '例: 会社員',
        },
        {
          name: 'preferred_contact_datetime_1',
          label: '連絡希望日時1',
          type: 'datetime-local',
          required: false,
          placeholder: '',
        },
        {
          name: 'preferred_contact_datetime_2',
          label: '連絡希望日時2',
          type: 'datetime-local',
          required: false,
          placeholder: '',
        },
        {
          name: 'consultation_notes',
          label: 'ご相談内容',
          type: 'textarea',
          required: false,
          placeholder: '例: 既往歴について詳しく相談したい',
        },
        {
          name: 'remarks',
          label: '備考',
          type: 'textarea',
          required: false,
          placeholder: 'その他ご要望など',
        },
        {
          name: 'privacy_policy_agreed',
          label: '個人情報保護方針に同意する ※',
          type: 'checkbox',
          required: true,
        },
      ],
    });
  }

  // 必須項目のバリデーション
  const requiredFields = [
    'last_name', 'first_name', 'last_name_kana', 'first_name_kana',
    'birth_date', 'gender', 'phone', 'email',
    'desired_coverage_amount', 'desired_coverage_period', 'privacy_policy_agreed'
  ];

  const missingFields = requiredFields.filter(field => !customerInfo[field]);
  
  if (missingFields.length > 0) {
    return createSuccessResponse({
      answer: `必須項目が入力されていません: ${missingFields.join(', ')}`,
      conversation_id: conversationId,
      state: 'FINAL_CONFIRMATION',
      disease_detected: null,
      confidence_score: 0,
      sources: [],
      type: 'error',
      requires_input: 'form',
    });
  }

  // メールアドレスの簡易バリデーション
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(customerInfo.email)) {
    return createSuccessResponse({
      answer: 'メールアドレスの形式が正しくありません。',
      conversation_id: conversationId,
      state: 'FINAL_CONFIRMATION',
      disease_detected: null,
      confidence_score: 0,
      sources: [],
      type: 'error',
      requires_input: 'form',
    });
  }

  // プライバシーポリシー同意確認
  if (!customerInfo.privacy_policy_agreed) {
    return createSuccessResponse({
      answer: '個人情報保護方針への同意が必要です。',
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
    { customer_info: customerInfo },
    { 
      role: 'user', 
      content: `お客様情報: ${customerInfo.last_name} ${customerInfo.first_name}様` 
    }
  );

  // 完了メッセージを作成
  const fullName = `${customerInfo.last_name} ${customerInfo.first_name}`;
  const genderLabel = customerInfo.gender === 'male' ? '男性' : customerInfo.gender === 'female' ? '女性' : 'その他';
  
  return createSuccessResponse({
    answer: `✅ **ヒアリング完了**\n\n${fullName}様、ご入力ありがとうございました。\n\n担当者より、ご連絡先（${customerInfo.phone}）へ折り返しご連絡させていただきます。\n\n今しばらくお待ちください。`,
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
    
    console.log('[JWT Token] Proxying login request to Django API');
    
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
    
    console.log(`[JWT Token] Django response status: ${djangoResponse.status}`);
    
    return new Response(responseBody, {
      status: djangoResponse.status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('[JWT Token] Django token proxy error:', error);
    return new Response(
      JSON.stringify({
        error: '認証サーバーへの接続中にエラーが発生しました',
        details: error instanceof Error ? error.message : 'Unknown error'
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
    
    console.log('[JWT Refresh] Proxying refresh request to Django API');
    
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
    
    console.log(`[JWT Refresh] Django response status: ${djangoResponse.status}`);
    
    return new Response(responseBody, {
      status: djangoResponse.status,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('[JWT Refresh] Django token refresh proxy error:', error);
    return new Response(
      JSON.stringify({
        error: 'トークン更新サーバーへの接続中にエラーが発生しました',
        details: error instanceof Error ? error.message : 'Unknown error'
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
        remaining_tokens: 1000
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Token consume error:', error);
    return new Response(
      JSON.stringify({ error: 'トークン消費処理中にエラーが発生しました' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * 会話一覧取得エンドポイント
 */
async function handleConversationList(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const userParam = url.searchParams.get('user');
    
    if (!userParam) {
      return new Response(
        JSON.stringify({ error: 'User parameter is required' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    console.log(`[Conversation List] Fetching conversations for user: ${userParam}`);

    // D1データベースから会話一覧を取得
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, state, created_at, updated_at, messages
       FROM conversations 
       WHERE user_id = ? 
       ORDER BY updated_at DESC 
       LIMIT 50`
    ).bind(userParam).all();

    // 会話一覧を整形
    const conversations = results.map((row: any) => {
      let messages = [];
      try {
        messages = JSON.parse(row.messages || '[]');
      } catch (e) {
        console.error('Failed to parse messages:', e);
      }

      // 最初のユーザーメッセージをタイトルとして使用
      const firstUserMessage = messages.find((m: any) => m.role === 'user');
      const title = firstUserMessage 
        ? firstUserMessage.content.substring(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '')
        : '新しい会話';

      return {
        conversation_id: row.id,
        title,
        created_at: row.created_at,
        updated_at: row.updated_at,
        message_count: messages.length,
        state: row.state || 'INITIAL'
      };
    });

    console.log(`[Conversation List] Found ${conversations.length} conversations`);

    return new Response(
      JSON.stringify({ conversations }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[Conversation List] Error:', error);
    return new Response(
      JSON.stringify({ 
        error: '会話一覧取得中にエラーが発生しました',
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

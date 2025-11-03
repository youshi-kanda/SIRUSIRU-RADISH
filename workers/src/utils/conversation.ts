/**
 * 会話状態管理ユーティリティ
 */

import type { 
  Env, 
  Conversation, 
  ConversationState, 
  CollectedData,
  ConversationMessage 
} from '../types';

/**
 * 会話を取得または新規作成
 */
export async function getOrCreateConversation(
  env: Env,
  conversationId: string,
  userId: string | null
): Promise<Conversation> {
  const existing = await env.DB.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).bind(conversationId).first<Conversation>();

  if (existing) {
    return existing;
  }

  // 新規会話を作成
  const newConv: Conversation = {
    id: conversationId,
    user_id: userId,
    state: 'INITIAL',
    current_step: null,
    collected_data: JSON.stringify({}),
    messages: JSON.stringify([]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await env.DB.prepare(
    `INSERT INTO conversations (id, user_id, state, current_step, collected_data, messages, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    newConv.id,
    newConv.user_id,
    newConv.state,
    newConv.current_step,
    newConv.collected_data,
    newConv.messages,
    newConv.created_at,
    newConv.updated_at
  ).run();

  return newConv;
}

/**
 * 会話状態を更新
 */
export async function updateConversationState(
  env: Env,
  conversationId: string,
  state: ConversationState,
  collectedData?: Partial<CollectedData>,
  newMessage?: { role: 'user' | 'assistant'; content: string }
): Promise<void> {
  const conv = await env.DB.prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).bind(conversationId).first<Conversation>();

  if (!conv) {
    throw new Error('Conversation not found');
  }

  // 既存データをマージ
  const currentData: CollectedData = JSON.parse(conv.collected_data || '{}');
  const updatedData = { ...currentData, ...collectedData };

  // メッセージを追加
  const messages: ConversationMessage[] = JSON.parse(conv.messages || '[]');
  if (newMessage) {
    messages.push({
      ...newMessage,
      timestamp: new Date().toISOString(),
    });
  }

  await env.DB.prepare(
    `UPDATE conversations 
     SET state = ?, collected_data = ?, messages = ?, updated_at = ?
     WHERE id = ?`
  ).bind(
    state,
    JSON.stringify(updatedData),
    JSON.stringify(messages),
    new Date().toISOString(),
    conversationId
  ).run();
}

/**
 * 収集済みデータを取得
 */
export function getCollectedData(conversation: Conversation): CollectedData {
  return JSON.parse(conversation.collected_data || '{}');
}

/**
 * メッセージ履歴を取得
 */
export function getMessages(conversation: Conversation): ConversationMessage[] {
  return JSON.parse(conversation.messages || '[]');
}

/**
 * 次の状態を決定
 */
export function determineNextState(
  currentState: ConversationState,
  data: CollectedData
): ConversationState {
  switch (currentState) {
    case 'INITIAL':
      return 'TREATMENT_CHECK';

    case 'TREATMENT_CHECK':
      if (data.hasTreatment === 'yes') {
        return 'DIAGNOSIS_KNOWLEDGE_CHECK';
      } else if (data.hasTreatment === 'no') {
        return 'RESULT';
      }
      return 'TREATMENT_CHECK';

    case 'DIAGNOSIS_KNOWLEDGE_CHECK':
      if (data.knowsDiagnosis === true) {
        return 'DIAGNOSIS_INPUT';
      } else if (data.knowsDiagnosis === false) {
        return 'SYMPTOM_INPUT';
      }
      return 'DIAGNOSIS_KNOWLEDGE_CHECK';

    case 'DIAGNOSIS_INPUT':
      return 'RESULT';

    case 'SYMPTOM_INPUT':
      // 十分な情報が集まったか判定
      if (data.symptoms && data.symptoms.length >= 2) {
        return 'RESULT';
      }
      return 'SYMPTOM_FOLLOWUP';

    case 'SYMPTOM_FOLLOWUP':
      return 'RESULT';

    case 'RESULT':
      return 'FINAL_CONFIRMATION';

    case 'FINAL_CONFIRMATION':
      return 'COMPLETED';

    default:
      return currentState;
  }
}

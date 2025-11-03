/**
 * SIRUSIRU Radish AI Engine - Type Definitions
 */

// ===================================
// Cloudflare Workers Environment
// ===================================
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  BACKUP: R2Bucket;
  OPENAI_API_KEY: string;
  ENVIRONMENT: 'development' | 'production';
}

// ===================================
// Knowledge Database Models
// ===================================
export interface Knowledge {
  id: number;
  disease_code: string;
  disease_name: string;
  condition: string | null;
  main_contract: string | null;
  medical_rider: string | null;
  cancer_rider: string | null;
  income_rider: string | null;
  remarks: string | null;
  content_full: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchResult {
  knowledge: Knowledge;
  score: number;
  rank: number;
}

// ===================================
// Conversation State Management
// ===================================
export type ConversationState = 
  | 'INITIAL'                    // 初回: 5年以内の治療・経過観察確認
  | 'TREATMENT_CHECK'            // 治療確認後の分岐待ち
  | 'DIAGNOSIS_KNOWLEDGE_CHECK'  // 診断名を知っているか確認
  | 'DIAGNOSIS_INPUT'            // 診断名入力待ち
  | 'SYMPTOM_INPUT'              // 症状入力待ち(複数ターン可)
  | 'SYMPTOM_FOLLOWUP'           // 症状追加質問
  | 'RESULT'                     // 判定結果表示
  | 'FINAL_CONFIRMATION'         // 最終ヒアリング
  | 'COMPLETED';                 // 完了

export interface CollectedData {
  hasTreatment?: 'yes' | 'no';   // 治療有無
  knowsDiagnosis?: boolean;      // 診断名を知っているか
  diagnosisName?: string;        // 診断名
  symptoms?: string[];           // 症状リスト
  name?: string;                 // 顧客名
  gender?: 'male' | 'female' | 'other'; // 性別
  age?: number;                  // 年齢
}

export interface Conversation {
  id: string; // conversation_id
  user_id: string | null;
  state: ConversationState;
  current_step: string | null;
  collected_data: string; // JSON化したCollectedData
  messages: string; // JSON化したメッセージ履歴
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// ===================================
// API Request/Response Models
// ===================================
export interface ChatRequest {
  query?: string; // 旧フィールド（後方互換性）
  message?: string; // 新フィールド
  conversation_id?: string;
  user_id?: string;
  selection?: string; // 選択肢入力用(yes_with_diagnosis, yes_without_diagnosis, no)
  form_data?: { // フォームデータ
    name?: string;
    gender?: 'male' | 'female' | 'other';
    age?: number;
  };
}

export interface ChatResponse {
  answer: string;
  conversation_id: string;
  state?: ConversationState; // 現在の会話状態(オプション)
  disease_detected: string | null;
  confidence_score: number;
  sources: Source[];
  type: 'greeting' | 'question' | 'result' | 'confirmation' | 'error' | 'symptom' | 'disease' | 'form'; // より詳細な型
  suggestions?: string[]; // 疾病候補または選択肢
  options?: ResponseOption[]; // ユーザー選択肢(ボタン表示用)
  requires_input?: 'text' | 'selection' | 'form'; // 次の入力タイプ
  form_fields?: FormField[]; // フォームフィールド定義
  authenticated?: boolean; // 認証済みかどうか
  user?: {
    id: number;
    email: string;
    name: string | null;
    role: string;
  };
}

export interface FormField {
  name: string; // フィールド名(name, gender, age)
  label: string; // 表示ラベル
  type: 'text' | 'select' | 'number'; // 入力タイプ
  required: boolean;
  options?: { value: string; label: string }[]; // select用の選択肢
  placeholder?: string;
}

export interface ResponseOption {
  value: string; // 内部値(yes_with_diagnosis, yes_without_diagnosis, no)
  label: string; // 表示ラベル
  description?: string; // 説明文
}

export interface Source {
  source_file: string;
  chunk_text: string;
  score: number;
}

// ===================================
// Internal Processing Models
// ===================================
export interface ClassificationResult {
  type: 'DISEASE' | 'SYMPTOM' | 'OTHER';
  input: string;
  confidence: number;
}

export interface DiseaseCandidate {
  disease_name: string;
  confidence: number;
  reasoning: string;
}

export interface SymptomResponse {
  candidates: DiseaseCandidate[];
  message: string;
}

export interface UnderwritingJudgement {
  disease_name: string;
  disease_code: string;
  condition: string;
  main_contract: string;
  medical_rider: string;
  cancer_rider: string;
  income_rider: string;
  remarks: string;
}

// ===================================
// OpenAI API Models
// ===================================
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature: number;
  max_tokens?: number;
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: OpenAIMessage;
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ===================================
// Error Models
// ===================================
export interface APIError {
  error: string;
  code: string;
  details?: string;
  timestamp: string;
}

// ===================================
// Authentication Models
// ===================================
export interface User {
  id: number;
  email: string;
  name: string | null;
  role: 'admin' | 'user' | 'operator';
  is_active: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface AuthSession {
  id: string;
  user_id: number;
  token: string;
  expires_at: string;
  created_at: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  token?: string;
  user?: {
    id: number;
    email: string;
    name: string | null;
    role: string;
  };
  error?: string;
}

export interface AuthenticatedRequest {
  user: User;
  token: string;
}

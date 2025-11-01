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
// Conversation Models
// ===================================
export interface Conversation {
  id: number;
  conversation_id: string;
  user_id: string | null;
  user_message: string;
  ai_response: string;
  disease_detected: string | null;
  confidence_score: number | null;
  sources: string;
  created_at: string;
}

// ===================================
// API Request/Response Models
// ===================================
export interface ChatRequest {
  query: string;
  conversation_id?: string;
  user_id?: string;
}

export interface ChatResponse {
  answer: string;
  conversation_id: string;
  disease_detected: string | null;
  confidence_score: number;
  sources: Source[];
  type: 'symptom' | 'disease' | 'error';
  suggestions?: string[];
}

export interface Source {
  disease_code: string;
  disease_name: string;
  condition: string | null;
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

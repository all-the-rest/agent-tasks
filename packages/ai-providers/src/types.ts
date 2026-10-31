export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCallRequest[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Stable conversation id; forwarded through the provider's session header. */
  sessionId: string;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  allowanceUsd?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  usage?: Usage;
  finishReason?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  supportsTools: boolean;
  contextLength?: number;
}

export interface ProviderFailure {
  code: 'unavailable' | 'auth' | 'rate_limited' | 'model_missing' | 'bad_response' | 'timeout' | 'unsupported';
  message: string;
}

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderFailure['code'],
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderContext {
  /** Decrypted credential, never logged. */
  apiKey?: string;
  config: Record<string, unknown>;
}

export interface AiProvider {
  readonly kind: string;
  listModels(context: ProviderContext): Promise<ModelInfo[]>;
  chat(context: ProviderContext, request: ChatRequest): Promise<ChatResponse>;
  health(context: ProviderContext): Promise<{ ok: boolean; message: string }>;
}

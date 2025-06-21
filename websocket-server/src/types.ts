// Basic interface for the ARI client, to be expanded as needed
// This will be replaced by the more detailed AriClientInterface below.
// export interface AriClient {
//   playbackAudio: (channelId: string, audioPayload: string) => void;
//   endCall: (channelId: string) => void;
//   // Add other methods like startExternalMedia, answerCall etc. as they are implemented
// }

// Information related to an active Asterisk call
export interface AriCallInfo {
  channelId: string;
  ariClient: AriClientInterface; // Using the new AriClientInterface
}

export interface FunctionCallItem {
  name: string;
  arguments: string;
  call_id?: string;
}

export interface FunctionSchema {
  name: string;
  type: "function";
  description?: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export interface FunctionHandler {
  schema: FunctionSchema;
  handler: (args: any) => Promise<string>;
}

// Configuration Types based on default.json structure

export interface VadConfig {
  vadSilenceThresholdMs: number; // For TALK_DETECT silence duration
  vadRecognitionActivationMs: number; // For TALK_DETECT talk duration (previously vadTalkThresholdMs)
}

export interface AppRecognitionConfig {
  recognitionActivationMode: "VAD" | "MANUAL" | "IMMEDIATE" | "FIXED_DELAY"; // Expanded modes
  noSpeechBeginTimeoutSeconds: number;
  speechCompleteTimeoutSeconds: number;
  initialOpenAIStreamIdleTimeoutSeconds?: number;
  vadConfig: VadConfig;
  maxRecognitionDurationSeconds?: number;
  greetingAudioPath?: string;
  bargeInDelaySeconds?: number; // For FIXED_DELAY mode, moved here for consistency from direct usage

  vadRecogActivation?: 'vadMode' | 'afterPrompt'; // How VAD initiates recognition stream
  vadInitialSilenceDelaySeconds?: number; // Delay before VAD becomes active (for vadMode)
  vadActivationDelaySeconds?: number; // Additional delay after prompt before VAD becomes active (for vadMode)
  vadMaxWaitAfterPromptSeconds?: number; // Max time to wait for speech after a prompt in VAD mode
}

export interface DtmfConfig {
  dtmfEnabled: boolean;
  dtmfInterdigitTimeoutSeconds: number;
  dtmfMaxDigits: number;
  dtmfTerminatorDigit: string;
  dtmfFinalTimeoutSeconds?: number; // Timeout after the last DTMF digit before finalizing input
}

export interface BargeInConfig {
  bargeInModeEnabled: boolean;
  bargeInDelaySeconds: number;
  noSpeechBargeInTimeoutSeconds: number;
}

export interface AppConfig {
  appRecognitionConfig: AppRecognitionConfig;
  dtmfConfig: DtmfConfig;
  bargeInConfig: BargeInConfig;
}

export interface OpenAIRealtimeAPIConfig {
  model?: string; // Unified model for Realtime API sessions
  language?: string; // e.g., "en" or "en-US"
  inputAudioFormat?: string; // e.g., "pcm_s16le", "g711_ulaw"
  inputAudioSampleRate?: number; // e.g., 8000, 16000
  outputAudioFormat?: string; // e.g., "mp3", "pcm_s16le"
  outputAudioSampleRate?: number; // e.g., 24000, 16000
  ttsVoice?: string; // e.g., "alloy"
  transcriptionIntentOnly?: boolean; // Custom flag if STT is only for intent not full conversation
  responseModalities?: string | ("audio" | "text")[]; // Can be string from config, parsed to array
  instructions?: string; // For system prompt/instructions sent in session.update
  instructions_es?: string; // Specifically for Spanish instructions
  prompt_es?: string; // Specifically for Spanish prompt
  noInputTimeoutPlayback?: string;
  endOfCallPhrase_es?: string;


  // Deprecated fields, kept for potential reference or if used by older configs:
  audioFormat?: string;
  encoding?: string;
  sampleRate?: number;
  // For any other custom session parameters for OpenAI
  saved_config?: Record<string, any>;
  apiKey?: string; // This was present before, sessionManager now sources from env.
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error"; // Common log levels
  prettyPrint?: boolean;
  destination?: string;
}

export interface TimersConfig {
    noSpeechBeginTimeoutSeconds: number;
    initialOpenAIStreamIdleTimeoutSeconds: number;
    subsequentOpenAIStreamIdleTimeoutSeconds: number;
    vadNoInputTimeoutSeconds: number;
    maxCallDurationSeconds: number;
}

export interface AudioCaptureConfig {
    enabled?: boolean;
    path?: string;
}

export interface VADModeConfig {
    speechThreshold: number;
    silenceThreshold: number;
    maxSpeechTimeSeconds: number;
    noInputTimeoutSeconds?: number; // Optional for general VAD, required for specific modes
    interimResults?: boolean; // For continuous
}
export interface VADConfig {
    mode: "afterPrompt" | "continuous";
    afterPrompt: VADModeConfig;
    continuous: VADModeConfig;
}


export interface FullConfig {
  asterisk: {
    username?: string;
    password?: string;
    url?: string;
    ariAppName?: string;
  };
  server: {
    port?: number;
  };
  openai: OpenAIRealtimeAPIConfig; // Nested OpenAI config
  logging: LoggingConfig;
  timers: TimersConfig;
  audioCapture: AudioCaptureConfig;
  vad: VADConfig;
  // Old top-level appConfig, dtmfConfig, bargeInConfig might be here or intended to be moved/restructured.
  // For now, CallSpecificConfig will extend this.
  appConfig?: AppConfig; // Optional if being phased out or merged
  dtmfConfig?: DtmfConfig; // Optional
  bargeInConfig?: BargeInConfig; // Optional
}


// CallSpecificConfig now directly uses/embeds parts of FullConfig or specific sub-configs.
// This matches how config.get<Type>(path) would typically be used.
export interface CallSpecificConfig {
  openAIRealtimeAPI: OpenAIRealtimeAPIConfig; // Required
  logging: LoggingConfig; // Required
  timers: TimersConfig; // Required
  audioCapture: AudioCaptureConfig; // Required
  vad: VADConfig; // Required
  // Include other parts of FullConfig if they are truly call-specific and not global
  // For example, if ariAppName could vary per call (unlikely but for illustration)
  asteriskAriAppName?: string;
}

// Definition for a generic logger instance
export type Logger = LoggerInstance; // Exporting Logger as an alias for LoggerInstance
export interface LoggerInstance {
  info: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
  child: (bindings: object) => LoggerInstance;
  silly?: (message: string, ...args: any[]) => void; // Added
  isLevelEnabled?: (level: string) => boolean;    // Added
}

// Interface for the AriClientService that sessionManager will interact with
export interface AriClientInterface {
  logger: LoggerInstance; // Expose logger for sessionManager if needed
  _onOpenAISpeechStarted: (callId: string) => void;
  _onOpenAIInterimResult: (callId: string, transcript: string) => void;
  _onOpenAIFinalResult: (callId: string, transcript: string) => void;
  _onOpenAIError: (callId: string, error: any) => void;
  _onOpenAISessionEnded: (callId: string, reason: string) => void;
  playbackAudio: (channelId: string, audioPayloadB64: string) => Promise<void>;
  _onOpenAIAudioChunk: (callId: string, audioChunkBase64: string, isLastChunk: boolean) => void; // Added for TTS audio streaming
  // Potentially other methods like endCall, if sessionManager needs to trigger them directly
}

// Renaming the old AriClient to avoid conflict if it's still used elsewhere,
// though it's better to fully transition to AriClientInterface.
// Removing problematic self-referential export:
// export { AriClient as DeprecatedAriClient } from './types';

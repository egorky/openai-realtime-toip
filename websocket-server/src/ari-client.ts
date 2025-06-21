import Ari, { Channel, Bridge, Playback, PlaybackFinished, ChannelTalkingStarted, ChannelTalkingFinished, ChannelDtmfReceived } from 'ari-client';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { RtpServer } from './rtp-server';
import * as sessionManager from './sessionManager';
import {
  AriClientInterface,
  CallSpecificConfig,
  RuntimeConfig,
  AppRecognitionConfig,
  DtmfConfig,
  LoggerInstance
} from './types';

// Transcoding libraries removed
// let g711: any = null; // Keep variable for type checking, but don't require
// let Resampler: any = null; // Keep variable for type checking, but don't require

const moduleLogger: LoggerInstance = {
  info: console.log, error: console.error, warn: console.warn, debug: console.log, silly: console.log,
  isLevelEnabled: (level: string) => level !== 'silly',
  child: (bindings: object) => moduleLogger,
};

dotenv.config();

function getVar(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: string, channelVarName?: string): string | undefined {
  const astVarName = channelVarName || `APP_${envVarName}`;
  let value: string | undefined;
  // TODO: Add channel variable fetching logic here if 'channel' is provided
  // Example: if (channel && channelVarName) { try { value = await channel.getChannelVar({ variable: channelVarName })).value; } catch(e){} }
  if (value === undefined) { value = process.env[envVarName]; }
  if (value === undefined) { value = defaultValue; }
  return value;
}
function getVarAsInt(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: number, channelVarName?: string): number | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  const intValue = parseInt(value, 10);
  if (isNaN(intValue)) { logger.warn(`Invalid int for ${envVarName}: ${value}, using default ${defaultValue}`); return defaultValue; }
  return intValue;
}
function getVarAsFloat(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: number, channelVarName?: string): number | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  const floatValue = parseFloat(value);
  if (isNaN(floatValue)) { logger.warn(`Invalid float for ${envVarName}: ${value}, using default ${defaultValue}`); return defaultValue; }
  return floatValue;
}
function getVarAsBoolean(logger: any, channel: Channel | undefined, envVarName: string, defaultValue?: boolean, channelVarName?: string): boolean | undefined {
  const value = getVar(logger, channel, envVarName, defaultValue?.toString(), channelVarName);
  if (value === undefined) return undefined;
  if (typeof value === 'string') { return value.toLowerCase() === 'true' || value === '1'; }
  return defaultValue;
}

function getCallSpecificConfig(logger: any, channel?: Channel): CallSpecificConfig {
  const configFilePath = process.env.CONFIG_FILE_PATH || path.join(__dirname, '../config/default.json');
  let baseConfig: RuntimeConfig;
  try {
    const rawConfig = fs.readFileSync(configFilePath, 'utf-8');
    baseConfig = JSON.parse(rawConfig) as RuntimeConfig;
  } catch (e: unknown) {
    if (e instanceof Error) {
        logger.error(`Config load error from ${configFilePath}: ${e.message}. Using hardcoded fallbacks.`);
    } else {
        logger.error(`Config load error from ${configFilePath}: ${String(e)}. Using hardcoded fallbacks.`);
    }
    baseConfig = {
      appConfig: {
        appRecognitionConfig: {
          recognitionActivationMode: "VAD", noSpeechBeginTimeoutSeconds: 3, speechCompleteTimeoutSeconds: 5,
          vadConfig: { vadSilenceThresholdMs: 250, vadRecognitionActivationMs: 40 },
          maxRecognitionDurationSeconds: 30, greetingAudioPath: 'sound:hello-world', bargeInDelaySeconds: 0.5,
          vadRecogActivation: 'afterPrompt', vadInitialSilenceDelaySeconds: 0, vadActivationDelaySeconds: 0, vadMaxWaitAfterPromptSeconds: 5,
        },
        dtmfConfig: { dtmfEnabled: true, dtmfInterdigitTimeoutSeconds: 2, dtmfMaxDigits: 16, dtmfTerminatorDigit: "#", dtmfFinalTimeoutSeconds: 3 },
        bargeInConfig: { bargeInModeEnabled: true, bargeInDelaySeconds: 0.5, noSpeechBargeInTimeoutSeconds: 5 },
      },
      openAIRealtimeAPI: { model: "gpt-4o-mini-realtime-preview-2024-12-17", inputAudioFormat: "mulaw_8000hz", inputAudioSampleRate: 8000, outputAudioFormat: "pcm_s16le_24000hz", outputAudioSampleRate: 24000, responseModalities: ["audio", "text"], instructions: "Eres un asistente de IA amigable y servicial. Responde de manera concisa." },
      logging: { level: "info" },
    };
  }
  const callConfig = JSON.parse(JSON.stringify(baseConfig)) as CallSpecificConfig;
  callConfig.logging.level = getVar(logger, channel, 'LOG_LEVEL', callConfig.logging.level) as any || callConfig.logging.level;
  const arc = callConfig.appConfig.appRecognitionConfig = callConfig.appConfig.appRecognitionConfig || {} as AppRecognitionConfig;
  arc.greetingAudioPath = getVar(logger, channel, 'GREETING_AUDIO_PATH', arc.greetingAudioPath) || 'sound:hello-world';
  arc.maxRecognitionDurationSeconds = getVarAsInt(logger, channel, 'MAX_RECOGNITION_DURATION_SECONDS', arc.maxRecognitionDurationSeconds) || 30;
  arc.noSpeechBeginTimeoutSeconds = getVarAsInt(logger, channel, 'NO_SPEECH_BEGIN_TIMEOUT_SECONDS', arc.noSpeechBeginTimeoutSeconds) ?? 3;
  arc.speechCompleteTimeoutSeconds = getVarAsInt(logger, channel, 'SPEECH_COMPLETE_TIMEOUT_SECONDS', arc.speechCompleteTimeoutSeconds) ?? 5;
  arc.bargeInDelaySeconds = getVarAsFloat(logger, channel, 'BARGE_IN_DELAY_SECONDS', arc.bargeInDelaySeconds ?? callConfig.appConfig.bargeInConfig?.bargeInDelaySeconds) ?? 0.5;
  arc.vadRecogActivation = getVar(logger, channel, 'VAD_RECOG_ACTIVATION_MODE', arc.vadRecogActivation) as 'vadMode' | 'afterPrompt' || 'afterPrompt';
  arc.vadInitialSilenceDelaySeconds = getVarAsInt(logger, channel, 'VAD_INITIAL_SILENCE_DELAY_SECONDS', arc.vadInitialSilenceDelaySeconds) ?? 0;
  arc.vadActivationDelaySeconds = getVarAsInt(logger, channel, 'VAD_ACTIVATION_DELAY_SECONDS', arc.vadActivationDelaySeconds) ?? 0;
  arc.vadMaxWaitAfterPromptSeconds = getVarAsInt(logger, channel, 'VAD_MAX_WAIT_AFTER_PROMPT_SECONDS', arc.vadMaxWaitAfterPromptSeconds) ?? 5;
  arc.vadConfig = arc.vadConfig || { vadSilenceThresholdMs: 250, vadRecognitionActivationMs: 40 };
  arc.vadConfig.vadSilenceThresholdMs = getVarAsInt(logger, channel, 'VAD_SILENCE_THRESHOLD_MS', arc.vadConfig.vadSilenceThresholdMs) ?? 250;
  arc.vadConfig.vadRecognitionActivationMs = getVarAsInt(logger, channel, 'VAD_TALK_THRESHOLD_MS', arc.vadConfig.vadRecognitionActivationMs) ?? 40;
  const dtmfConf = callConfig.appConfig.dtmfConfig = callConfig.appConfig.dtmfConfig || {} as DtmfConfig;
  dtmfConf.dtmfEnabled = getVarAsBoolean(logger, channel, 'DTMF_ENABLED', dtmfConf.dtmfEnabled) ?? true;
  dtmfConf.dtmfInterdigitTimeoutSeconds = getVarAsInt(logger, channel, 'DTMF_INTERDIGIT_TIMEOUT_SECONDS', dtmfConf.dtmfInterdigitTimeoutSeconds) ?? 2;
  dtmfConf.dtmfMaxDigits = getVarAsInt(logger, channel, 'DTMF_MAX_DIGITS', dtmfConf.dtmfMaxDigits) ?? 16;
  dtmfConf.dtmfTerminatorDigit = getVar(logger, channel, 'DTMF_TERMINATOR_DIGIT', dtmfConf.dtmfTerminatorDigit) ?? "#";
  dtmfConf.dtmfFinalTimeoutSeconds = getVarAsInt(logger, channel, 'DTMF_FINAL_TIMEOUT_SECONDS', dtmfConf.dtmfFinalTimeoutSeconds) ?? 3;

  const oaiConf = callConfig.openAIRealtimeAPI = callConfig.openAIRealtimeAPI || {};
  oaiConf.model = getVar(logger, channel, 'OPENAI_REALTIME_MODEL', oaiConf.model, 'APP_OPENAI_REALTIME_MODEL') || "gpt-4o-mini-realtime-preview-2024-12-17";
  oaiConf.language = getVar(logger, channel, 'OPENAI_LANGUAGE', oaiConf.language) ?? "en";
  oaiConf.inputAudioFormat = getVar(logger, channel, 'OPENAI_INPUT_AUDIO_FORMAT', oaiConf.inputAudioFormat) ?? "mulaw_8000hz";
  oaiConf.inputAudioSampleRate = getVarAsInt(logger, channel, 'OPENAI_INPUT_AUDIO_SAMPLE_RATE', oaiConf.inputAudioSampleRate) ?? 8000;
  oaiConf.ttsVoice = getVar(logger, channel, 'APP_OPENAI_TTS_VOICE', oaiConf.ttsVoice) ?? "alloy";
  oaiConf.outputAudioFormat = getVar(logger, channel, 'OPENAI_OUTPUT_AUDIO_FORMAT', oaiConf.outputAudioFormat) ?? "pcm_s16le_24000hz";
  oaiConf.outputAudioSampleRate = getVarAsInt(logger, channel, 'OPENAI_OUTPUT_AUDIO_SAMPLE_RATE', oaiConf.outputAudioSampleRate) ?? 24000;

  oaiConf.instructions = getVar(logger, channel, 'OPENAI_INSTRUCTIONS', oaiConf.instructions, 'APP_OPENAI_INSTRUCTIONS');
  if (oaiConf.instructions === undefined) {
    oaiConf.instructions = "Eres un asistente de IA amigable y servicial. Responde de manera concisa.";
  }

  const defaultModalities = baseConfig.openAIRealtimeAPI?.responseModalities?.join(',') || 'audio,text';
  const modalitiesStr = getVar(logger, channel, 'OPENAI_RESPONSE_MODALITIES', defaultModalities, 'APP_OPENAI_RESPONSE_MODALITIES');

  if (modalitiesStr) {
    const validModalitiesSet = new Set(["audio", "text"]);
    const parsedModalities = modalitiesStr.split(',')
                                     .map(m => m.trim().toLowerCase())
                                     .filter(m => validModalitiesSet.has(m)) as ("audio" | "text")[];
    if (parsedModalities.length > 0) {
      oaiConf.responseModalities = parsedModalities;
    } else {
      logger.warn(`Invalid or empty OPENAI_RESPONSE_MODALITIES string: '${modalitiesStr}'. Defaulting to ${JSON.stringify(baseConfig.openAIRealtimeAPI?.responseModalities || ["audio", "text"])}.`);
      oaiConf.responseModalities = baseConfig.openAIRealtimeAPI?.responseModalities || ["audio", "text"];
    }
  } else {
    oaiConf.responseModalities = baseConfig.openAIRealtimeAPI?.responseModalities || ["audio", "text"];
  }
  if (!oaiConf.responseModalities) {
      oaiConf.responseModalities = ["audio", "text"];
  }

  if (!process.env.OPENAI_API_KEY) {
    logger.error("CRITICAL: OPENAI_API_KEY is not set in environment variables. OpenAI connection will fail.");
  }
  return callConfig;
}

const ASTERISK_ARI_URL = process.env.ASTERISK_ARI_URL || 'http://localhost:8088';
const ASTERISK_ARI_USERNAME = process.env.ASTERISK_ARI_USERNAME || 'asterisk';
const ASTERISK_ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || 'asterisk';
const ASTERISK_ARI_APP_NAME = process.env.ASTERISK_ARI_APP_NAME || 'openai-ari-app';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_RTP_HOST_IP = process.env.RTP_HOST_IP || '127.0.0.1';
const MAX_VAD_BUFFER_PACKETS = 200;

if (!OPENAI_API_KEY) { moduleLogger.error("FATAL: OPENAI_API_KEY environment variable is not set. Service will not be able to function."); }

interface CallResources {
  channel: Channel; config: CallSpecificConfig; callLogger: any; userBridge?: Bridge; snoopBridge?: Bridge;
  rtpServer?: RtpServer; externalMediaChannel?: Channel; snoopChannel?: Channel;
  mainPlayback?: Playback; waitingPlayback?: Playback; postRecognitionWaitingPlayback?: Playback;
  isCleanupCalled: boolean; promptPlaybackStoppedForInterim: boolean; fallbackAttempted: boolean;
  openAIStreamError: any; openAIStreamingActive: boolean; isOpenAIStreamEnding: boolean;
  speechHasBegun: boolean; finalTranscription: string; collectedDtmfDigits: string;
  dtmfModeActive: boolean; speechRecognitionDisabledDueToDtmf: boolean; dtmfInterruptedSpeech: boolean;
  vadSpeechDetected: boolean; vadAudioBuffer: Buffer[]; isVADBufferingActive: boolean;
  isFlushingVADBuffer: boolean; pendingVADBufferFlush: boolean; vadRecognitionTriggeredAfterInitialDelay: boolean;
  vadSpeechActiveDuringDelay: boolean; vadInitialSilenceDelayCompleted: boolean; vadActivationDelayCompleted: boolean;
  bargeInActivationTimer: NodeJS.Timeout | null; noSpeechBeginTimer: NodeJS.Timeout | null;
  initialOpenAIStreamIdleTimer: NodeJS.Timeout | null; speechEndSilenceTimer: NodeJS.Timeout | null;
  maxRecognitionDurationTimer: NodeJS.Timeout | null; dtmfInterDigitTimer: NodeJS.Timeout | null;
  dtmfFinalTimer: NodeJS.Timeout | null; vadMaxWaitAfterPromptTimer: NodeJS.Timeout | null;
  vadActivationDelayTimer: NodeJS.Timeout | null; vadInitialSilenceDelayTimer: NodeJS.Timeout | null;
  playbackFailedHandler?: ((event: any, failedPlayback: Playback) => void) | null;
  waitingPlaybackFailedHandler?: ((event: any, playback: Playback) => void) | null;
  ttsAudioChunks?: string[];
  currentTtsResponseId?: string;
}

export class AriClientService implements AriClientInterface {
  private client: Ari.Client | null = null;
  private activeCalls = new Map<string, CallResources>();
  private appOwnedChannelIds = new Set<string>();
  public logger: LoggerInstance = moduleLogger;
  private baseConfig: RuntimeConfig;

  constructor() {
    this.baseConfig = getCallSpecificConfig(this.logger.child({ context: 'AriBaseConfigLoad' }));
    this.logger = this.logger.child({ service: 'AriClientService' });
  }

  public async connect(): Promise<void> {
    try {
      this.client = await Ari.connect(ASTERISK_ARI_URL, ASTERISK_ARI_USERNAME, ASTERISK_ARI_PASSWORD);
      this.logger.info('Successfully connected to Asterisk ARI.');

      this.client.on('StasisStart', this.onStasisStart.bind(this));
      this.client.on('ChannelDtmfReceived', this._onDtmfReceived.bind(this));
      this.client.on('ChannelTalkingStarted', this._onChannelTalkingStarted.bind(this));
      this.client.on('ChannelTalkingFinished', this._onChannelTalkingFinished.bind(this));
      this.client.on('error' as any, (err: any) => { this.onAriError(err); });
      this.client.on('close' as any, () => { this.onAriClose(); });

      await this.client.start(ASTERISK_ARI_APP_NAME);
      this.logger.info(`ARI Stasis application '${ASTERISK_ARI_APP_NAME}' started and listening for calls.`);
    } catch (err: any) {
      if (err instanceof Error) {
        this.logger.error('FATAL: Failed to connect to Asterisk ARI or start Stasis app:', err.message, err.stack);
      } else {
        this.logger.error('FATAL: Failed to connect to Asterisk ARI or start Stasis app with unknown error object:', err);
      }
      throw err;
    }
  }

  public _onOpenAISpeechStarted(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} OpenAI speech recognition started (or first transcript received).`);
    if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
    if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
    call.speechHasBegun = true;
  }

  public _onOpenAIInterimResult(callId: string, transcript: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.debug(`${logPrefix} OpenAI interim transcript: "${transcript}"`);
    if (!call.speechHasBegun) {
        if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
        if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
        call.speechHasBegun = true;
        call.callLogger.info(`${logPrefix} Speech implicitly started with first interim transcript.`);
    }
    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim && call.config.appConfig.bargeInConfig.bargeInModeEnabled) {
      call.callLogger.info(`${logPrefix} Stopping main prompt due to interim transcript (barge-in).`);
      this._stopAllPlaybacks(call).catch(e => call.callLogger.error(`${logPrefix} Error stopping playback on interim: ` + (e instanceof Error ? e.message : String(e))));
      call.promptPlaybackStoppedForInterim = true;
    }
    if (call.speechEndSilenceTimer) clearTimeout(call.speechEndSilenceTimer);
    const silenceTimeout = (call.config.appConfig.appRecognitionConfig.speechCompleteTimeoutSeconds ?? 5) * 1000;
    call.speechEndSilenceTimer = setTimeout(() => {
      if (call.isCleanupCalled || !call.openAIStreamingActive) return;
      call.callLogger.warn(`${logPrefix} Silence detected for ${silenceTimeout}ms after interim transcript. Stopping OpenAI session for this turn.`);
      sessionManager.stopOpenAISession(callId, 'interim_result_silence_timeout');
    }, silenceTimeout);
  }

  public _onOpenAIFinalResult(callId: string, transcript: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} OpenAI final transcript received: "${transcript}"`);
    if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
    call.finalTranscription = transcript;
    call.callLogger.info(`${logPrefix} Final transcript processed. Requesting OpenAI response for text: "${transcript}"`);
    if (call.ttsAudioChunks) {
        call.ttsAudioChunks = [];
    }
    try {
      sessionManager.requestOpenAIResponse(callId, transcript, call.config);
    } catch (e: any) {
      call.callLogger.error(`${logPrefix} Error calling sessionManager.requestOpenAIResponse: ${e.message}`, e);
    }
    call.callLogger.info(`${logPrefix} Waiting for OpenAI to generate response (including potential audio).`);
  }

  public _onOpenAIAudioChunk(callId: string, audioChunkBase64: string, isLastChunk: boolean): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      (call?.callLogger || this.logger).warn(`[${callId}] _onOpenAIAudioChunk: Call not active or cleanup called. Ignoring audio chunk.`);
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    if (!call.ttsAudioChunks) {
      call.ttsAudioChunks = [];
    }
    if (audioChunkBase64 && audioChunkBase64.length > 0) {
       call.callLogger.debug(`${logPrefix} Received TTS audio chunk, length: ${audioChunkBase64.length}. IsLast: ${isLastChunk}`);
       call.ttsAudioChunks.push(audioChunkBase64);
    }
    if (isLastChunk) {
      if (call.ttsAudioChunks.length > 0) {
        const fullAudioBase64 = call.ttsAudioChunks.join('');
        call.callLogger.info(`${logPrefix} All TTS audio chunks received. Total base64 length: ${fullAudioBase64.length}. Playing audio.`);
        this.playbackAudio(callId, fullAudioBase64)
          .then(() => {
            call.callLogger.info(`${logPrefix} TTS audio playback initiated.`);
          })
          .catch(e => {
            call.callLogger.error(`${logPrefix} Error initiating TTS audio playback: ${e.message}`, e);
          });
      } else {
        call.callLogger.warn(`${logPrefix} Received isLastChunk=true for TTS, but no audio chunks were accumulated.`);
      }
      call.ttsAudioChunks = [];
    }
  }

  public _onOpenAIError(callId: string, error: any): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.error(`${logPrefix} OpenAI stream error reported by sessionManager:`, error);
    call.openAIStreamError = error;
    this._fullCleanup(callId, true, "OPENAI_STREAM_ERROR");
  }

  public _onOpenAISessionEnded(callId: string, reason: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) return;
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} OpenAI session ended event from sessionManager. Reason: ${reason}`);
    call.openAIStreamingActive = false;
    if (!call.finalTranscription && !call.openAIStreamError && !call.dtmfModeActive) {
        call.callLogger.warn(`${logPrefix} OpenAI session ended (reason: ${reason}) without final transcript, error, or DTMF. Call may continue or timeout.`);
    } else {
        call.callLogger.info(`${logPrefix} OpenAI session ended (reason: ${reason}). This is likely part of a normal flow (final result, DTMF, error, or explicit stop).`);
    }
  }

  private async _stopAllPlaybacks(call: CallResources): Promise<void> {
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    const playbacksToStop = [call.mainPlayback, call.waitingPlayback, call.postRecognitionWaitingPlayback];
    for (const playback of playbacksToStop) {
      if (playback) {
        try {
          call.callLogger.debug(`${logPrefix} Stopping playback ${playback.id}.`);
          await playback.stop();
        } catch (e:any) { call.callLogger.warn(`${logPrefix} Error stopping playback ${playback.id}: ${(e instanceof Error ? e.message : String(e))}`); }
      }
    }
    call.mainPlayback = undefined;
    call.waitingPlayback = undefined;
    call.postRecognitionWaitingPlayback = undefined;
  }

  private async _onDtmfReceived(event: ChannelDtmfReceived, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.isCleanupCalled) { return; }
    if (call.channel.id !== channel.id) { return; }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;

    call.callLogger.info(`${logPrefix} DTMF digit '${event.digit}' received.`);
    if (!call.config.appConfig.dtmfConfig.dtmfEnabled) {
      call.callLogger.info(`${logPrefix} DTMF disabled by config. Ignoring.`);
      return;
    }
    call.callLogger.info(`${logPrefix} Entering DTMF mode: interrupting speech/VAD activities.`);
    call.dtmfModeActive = true;
    call.speechRecognitionDisabledDueToDtmf = true;
    call.isVADBufferingActive = false;
    call.vadAudioBuffer = [];
    call.pendingVADBufferFlush = false;
    await this._stopAllPlaybacks(call);

    if (call.openAIStreamingActive) {
      call.callLogger.info(`${logPrefix} DTMF interrupting active OpenAI stream.`);
      call.dtmfInterruptedSpeech = true;
      sessionManager.stopOpenAISession(call.channel.id, 'dtmf_interrupt');
      call.openAIStreamingActive = false;
      if (call.noSpeechBeginTimer) { clearTimeout(call.noSpeechBeginTimer); call.noSpeechBeginTimer = null; }
      if (call.initialOpenAIStreamIdleTimer) { clearTimeout(call.initialOpenAIStreamIdleTimer); call.initialOpenAIStreamIdleTimer = null; }
      if (call.speechEndSilenceTimer) { clearTimeout(call.speechEndSilenceTimer); call.speechEndSilenceTimer = null; }
      call.speechHasBegun = false;
    }
    if(call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }
    if(call.vadActivationDelayTimer) { clearTimeout(call.vadActivationDelayTimer); call.vadActivationDelayTimer = null; }
    if(call.vadInitialSilenceDelayTimer) { clearTimeout(call.vadInitialSilenceDelayTimer); call.vadInitialSilenceDelayTimer = null; }

    call.collectedDtmfDigits += event.digit;
    call.callLogger.info(`${logPrefix} Collected DTMF: ${call.collectedDtmfDigits}`);

    if (call.dtmfInterDigitTimer) clearTimeout(call.dtmfInterDigitTimer);
    const interDigitTimeout = (call.config.appConfig.dtmfConfig.dtmfInterdigitTimeoutSeconds ?? 2) * 1000;
    call.dtmfInterDigitTimer = setTimeout(() => { call.callLogger.info(`${logPrefix} DTMF inter-digit timer expired.`); }, interDigitTimeout);

    if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
    const finalTimeout = (call.config.appConfig.dtmfConfig.dtmfFinalTimeoutSeconds ?? 3) * 1000;
    call.dtmfFinalTimer = setTimeout(async () => {
      if (call.isCleanupCalled) return;
      call.callLogger.info(`${logPrefix} DTMF final timeout. Digits: ${call.collectedDtmfDigits}`);
      if (call.dtmfModeActive && call.collectedDtmfDigits.length > 0) {
        try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
        catch (e: any) { call.callLogger.error(`${logPrefix} Error setting DTMF_RESULT: ${(e instanceof Error ? e.message : String(e))}`); }
        this._fullCleanup(call.channel.id, false, "DTMF_FINAL_TIMEOUT");
      } else { this._fullCleanup(call.channel.id, false, "DTMF_FINAL_TIMEOUT_NO_DIGITS"); }
    }, finalTimeout);

    const dtmfConfig = call.config.appConfig.dtmfConfig;
    if (event.digit === dtmfConfig.dtmfTerminatorDigit) {
      call.callLogger.info(`${logPrefix} DTMF terminator digit received.`);
      if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
      try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
      catch (e:any) { call.callLogger.error(`${logPrefix} Error setting DTMF_RESULT: ${(e instanceof Error ? e.message : String(e))}`); }
      this._fullCleanup(call.channel.id, false, "DTMF_TERMINATOR_RECEIVED");
    } else if (call.collectedDtmfDigits.length >= (dtmfConfig.dtmfMaxDigits ?? 16)) {
      call.callLogger.info(`${logPrefix} Max DTMF digits reached.`);
      if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
      try { await call.channel.setChannelVar({ variable: 'DTMF_RESULT', value: call.collectedDtmfDigits }); }
      catch (e:any) { call.callLogger.error(`${logPrefix} Error setting DTMF_RESULT: ${(e instanceof Error ? e.message : String(e))}`); }
      this._fullCleanup(call.channel.id, false, "DTMF_MAX_DIGITS_REACHED");
    }
  }

  private async _activateOpenAIStreaming(callId: string, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.openAIStreamingActive) {
      if(call?.openAIStreamingActive) {
        const logPrefixExisting = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
        call.callLogger.debug(`${logPrefixExisting} Activate called but stream already active. Reason: ${reason}`);
      }
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} Activating OpenAI streaming. Reason: ${reason}`);
    call.openAIStreamingActive = true;

    try {
      await sessionManager.startOpenAISession(callId, this, call.config);
      call.callLogger.info(`${logPrefix} Session manager initiated OpenAI session for ${callId}.`);
      if (call.pendingVADBufferFlush && call.vadAudioBuffer.length > 0) {
        call.callLogger.info(`${logPrefix} Flushing ${call.vadAudioBuffer.length} VAD audio packets to OpenAI.`);
        call.isVADBufferingActive = false;
        for (const audioPayload of call.vadAudioBuffer) { sessionManager.sendAudioToOpenAI(callId, audioPayload); }
        call.vadAudioBuffer = []; call.pendingVADBufferFlush = false;
      }
      const noSpeechTimeout = call.config.appConfig.appRecognitionConfig.noSpeechBeginTimeoutSeconds;
      if (noSpeechTimeout > 0 && !call.speechHasBegun) {
        call.noSpeechBeginTimer = setTimeout(() => {
          if (call.isCleanupCalled || call.speechHasBegun) return;
          call.callLogger.warn(`${logPrefix} No speech from OpenAI in ${noSpeechTimeout}s. Stopping session & call.`);
          sessionManager.stopOpenAISession(callId, "no_speech_timeout_in_ari");
          this._fullCleanup(callId, true, "NO_SPEECH_BEGIN_TIMEOUT");
        }, noSpeechTimeout * 1000);
        call.callLogger.info(`${logPrefix} NoSpeechBeginTimer started (${noSpeechTimeout}s).`);
      }
      const streamIdleTimeout = call.config.appConfig.appRecognitionConfig.initialOpenAIStreamIdleTimeoutSeconds ?? 10;
      call.initialOpenAIStreamIdleTimer = setTimeout(() => {
         if (call.isCleanupCalled || call.speechHasBegun) return;
         call.callLogger.warn(`${logPrefix} OpenAI stream idle for ${streamIdleTimeout}s. Stopping session & call.`);
         sessionManager.stopOpenAISession(callId, "initial_stream_idle_timeout_in_ari");
         this._fullCleanup(callId, true, "OPENAI_STREAM_IDLE_TIMEOUT");
      }, streamIdleTimeout * 1000);
      call.callLogger.info(`${logPrefix} InitialOpenAIStreamIdleTimer started (${streamIdleTimeout}s).`);
    } catch (error: any) {
        call.callLogger.error(`${logPrefix} Error during _activateOpenAIStreaming for ${callId}: ${(error instanceof Error ? error.message : String(error))}`);
        call.openAIStreamingActive = false;
        this._onOpenAIError(callId, error);
    }
  }

  private _handleVADDelaysCompleted(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD' || call.config.appConfig.appRecognitionConfig.vadRecogActivation !== 'vadMode') {
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.debug(`${logPrefix} VAD delays completed. InitialSilence: ${call.vadInitialSilenceDelayCompleted}, ActivationDelay: ${call.vadActivationDelayCompleted}`);

    if (call.vadInitialSilenceDelayCompleted && call.vadActivationDelayCompleted) {
      call.callLogger.info(`${logPrefix} VAD vadMode: All initial delays completed.`);
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }

      if (call.vadSpeechActiveDuringDelay) {
        call.callLogger.info(`${logPrefix} VAD vadMode: Speech detected during delays. Activating OpenAI stream.`);
        this._activateOpenAIStreaming(callId, "vad_speech_during_delay_window");
        call.pendingVADBufferFlush = true;
        if(call.channel) {
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`${logPrefix} VAD: Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info(`${logPrefix} VAD vadMode: Delays completed, no prior speech. Listening via TALK_DETECT.`);
        this._handlePostPromptVADLogic(callId);
      }
    }
  }

  private _handlePostPromptVADLogic(callId: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} VAD: Handling post-prompt/no-prompt logic for mode '${call.config.appConfig.appRecognitionConfig.vadRecogActivation}'.`);

    const vadRecogActivation = call.config.appConfig.appRecognitionConfig.vadRecogActivation;

    if (vadRecogActivation === 'afterPrompt') {
      if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }
      if (call.vadSpeechDetected) {
        call.callLogger.info(`${logPrefix} VAD (afterPrompt): Speech previously detected. Activating OpenAI stream.`);
        this._activateOpenAIStreaming(callId, "vad_afterPrompt_speech_during_prompt");
        call.pendingVADBufferFlush = true;
        if(call.channel) {
            call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' })
                .catch(e => call.callLogger.warn(`${logPrefix} VAD: Error removing TALK_DETECT: ${e.message}`));
        }
      } else {
        call.callLogger.info(`${logPrefix} VAD (afterPrompt): No speech during prompt. Starting max wait timer.`);
        const maxWait = call.config.appConfig.appRecognitionConfig.vadMaxWaitAfterPromptSeconds ?? 5;
        if (maxWait > 0) {
          if(call.vadMaxWaitAfterPromptTimer) clearTimeout(call.vadMaxWaitAfterPromptTimer);
          call.vadMaxWaitAfterPromptTimer = setTimeout(() => {
            if (call.isCleanupCalled || call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) return;
            call.callLogger.warn(`${logPrefix} VAD (afterPrompt): Max wait ${maxWait}s reached. Ending call.`);
            if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`${logPrefix} VAD: Error removing TALK_DETECT: ${e.message}`)); }
            this._fullCleanup(callId, true, "VAD_MAX_WAIT_TIMEOUT");
          }, maxWait * 1000);
        } else {
            call.callLogger.info(`${logPrefix} VAD (afterPrompt): Max wait is 0 and no speech during prompt. Ending call.`);
            if(call.channel) { call.channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' }).catch(e => call.callLogger.warn(`${logPrefix} VAD: Error removing TALK_DETECT: ${e.message}`)); }
            this._fullCleanup(callId, true, "VAD_MAX_WAIT_0_NO_SPEECH");
        }
      }
    } else if (vadRecogActivation === 'vadMode') {
      call.callLogger.info(`${logPrefix} VAD vadMode: Delays completed, no speech during delay. Actively listening via TALK_DETECT.`);
    }
  }

  private async _onChannelTalkingStarted(event: ChannelTalkingStarted, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} TALK_DETECT: Speech started on channel ${channel.id}.`);

    if (call.vadRecognitionTriggeredAfterInitialDelay || call.openAIStreamingActive) { return; }

    const vadRecogActivation = call.config.appConfig.appRecognitionConfig.vadRecogActivation;
    if (vadRecogActivation === 'vadMode') {
      if (!call.vadInitialSilenceDelayCompleted || !call.vadActivationDelayCompleted) {
        call.callLogger.debug(`${logPrefix} VAD (vadMode): Speech detected during initial VAD delays.`);
        call.vadSpeechActiveDuringDelay = true;
        call.vadSpeechDetected = true;
        return;
      }
    } else if (vadRecogActivation === 'afterPrompt') {
      if (call.mainPlayback) {
        call.callLogger.debug(`${logPrefix} VAD (afterPrompt): Speech detected during main prompt.`);
        call.vadSpeechDetected = true;
        return;
      }
    }

    call.callLogger.info(`${logPrefix} VAD: Speech detected, proceeding to activate stream.`);
    call.vadSpeechDetected = true;
    call.vadRecognitionTriggeredAfterInitialDelay = true;

    if (call.mainPlayback && !call.promptPlaybackStoppedForInterim) {
      try {
        call.callLogger.info(`${logPrefix} VAD: Stopping main prompt due to speech.`);
        await call.mainPlayback.stop();
        call.promptPlaybackStoppedForInterim = true;
      } catch (e: any) { call.callLogger.warn(`${logPrefix} VAD: Error stopping main playback: ${e.message}`); }
    }

    if(call.bargeInActivationTimer) { clearTimeout(call.bargeInActivationTimer); call.bargeInActivationTimer = null; }
    if(call.vadMaxWaitAfterPromptTimer) { clearTimeout(call.vadMaxWaitAfterPromptTimer); call.vadMaxWaitAfterPromptTimer = null; }

    this._activateOpenAIStreaming(call.channel.id, "vad_speech_detected_direct");
    call.pendingVADBufferFlush = true;

    try {
      call.callLogger.info(`${logPrefix} VAD: Removing TALK_DETECT from channel after confirmed speech.`);
      await channel.setChannelVar({ variable: 'TALK_DETECT(remove)', value: 'true' });
    } catch (e: any) { call.callLogger.warn(`${logPrefix} VAD: Error removing TALK_DETECT: ${e.message}`); }
  }

  private async _onChannelTalkingFinished(event: ChannelTalkingFinished, channel: Channel): Promise<void> {
    const call = this.activeCalls.get(channel.id);
    if (!call || call.channel.id !== channel.id || call.isCleanupCalled || call.config.appConfig.appRecognitionConfig.recognitionActivationMode !== 'VAD') {
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} TALK_DETECT: Speech finished. Duration: ${event.duration}ms`);
    call.vadSpeechDetected = false;
    if (!call.vadInitialSilenceDelayCompleted || !call.vadActivationDelayCompleted) {
        call.vadSpeechActiveDuringDelay = false;
    }
  }

  private _handlePlaybackFinished(callId: string, reason: string): void {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;

    if (reason.startsWith('main_greeting_')) {
      call.callLogger.info(`${logPrefix} Handling post-greeting logic for call ${callId}. Reason: ${reason}`);
      call.mainPlayback = undefined;

      const activationMode = call.config.appConfig.appRecognitionConfig.recognitionActivationMode;
      if (activationMode === 'VAD') {
        this._handlePostPromptVADLogic(callId);
      } else if (activationMode === 'FIXED_DELAY') {
        const delaySeconds = call.config.appConfig.appRecognitionConfig.bargeInDelaySeconds ?? 0.5;
        call.callLogger.info(`${logPrefix} FixedDelay mode: Greeting finished/failed. Barge-in delay: ${delaySeconds}s.`);
        if (delaySeconds > 0) {
          if (call.bargeInActivationTimer) clearTimeout(call.bargeInActivationTimer);
          call.bargeInActivationTimer = setTimeout(() => {
            if (call.isCleanupCalled) return;
            this._activateOpenAIStreaming(callId, "fixedDelay_barge_in_timer_expired_post_greeting");
          }, delaySeconds * 1000);
        } else {
          this._activateOpenAIStreaming(callId, "fixedDelay_immediate_activation_post_greeting");
        }
      }
    }
  }

  private async onStasisStart(event: any, incomingChannel: Channel): Promise<void> {
    const callId = incomingChannel.id;
    const callLogger = this.logger.child({ callId, channelName: incomingChannel.name });
    const channelId = incomingChannel.id;
    const callerIdNum = incomingChannel.caller?.number || 'N/A';
    const logPrefix = `[${channelId}][Caller: ${callerIdNum}]`;

    if (incomingChannel.name.startsWith('UnicastRTP/') || incomingChannel.name.startsWith('Snoop/')) {
      callLogger.info(`${logPrefix} StasisStart for utility channel ${incomingChannel.name} (${incomingChannel.id}). Answering if needed and ignoring further setup.`);
      try {
        if (incomingChannel.state === 'RINGING' || incomingChannel.state === 'RING') {
          await incomingChannel.answer();
          callLogger.info(`${logPrefix} Answered utility channel ${incomingChannel.name}.`);
        }
      } catch (err: any) {
        callLogger.warn(`${logPrefix} Error answering utility channel ${incomingChannel.name} (may already be up or hungup): ${err.message}`);
      }
      return;
    }

    callLogger.info(`${logPrefix} StasisStart: New call entering application '${ASTERISK_ARI_APP_NAME}'.`);
    callLogger.info(`${logPrefix} New call onStasisStart. Channel ID: ${incomingChannel.id}, Name: ${incomingChannel.name}, Caller: ${JSON.stringify(incomingChannel.caller)}, Dialplan: ${JSON.stringify(incomingChannel.dialplan)}`);

    if (this.appOwnedChannelIds.has(callId)) {
      callLogger.info(`${logPrefix} Channel ${callId} is app-owned. Ignoring StasisStart.`); return;
    }
    const callConfig = getCallSpecificConfig(callLogger, incomingChannel);

    const callResources: CallResources = {
      channel: incomingChannel, config: callConfig, callLogger, isCleanupCalled: false,
      promptPlaybackStoppedForInterim: false, fallbackAttempted: false, openAIStreamError: null,
      openAIStreamingActive: false, isOpenAIStreamEnding: false, speechHasBegun: false,
      finalTranscription: "",
      collectedDtmfDigits: "", dtmfModeActive: false, speechRecognitionDisabledDueToDtmf: false, dtmfInterruptedSpeech: false,
      vadSpeechDetected: false, vadAudioBuffer: [], isVADBufferingActive: false, isFlushingVADBuffer: false,
      pendingVADBufferFlush: false, vadRecognitionTriggeredAfterInitialDelay: false, vadSpeechActiveDuringDelay: false,
      vadInitialSilenceDelayCompleted: false, vadActivationDelayCompleted: false,
      bargeInActivationTimer: null, noSpeechBeginTimer: null, initialOpenAIStreamIdleTimer: null,
      speechEndSilenceTimer: null, maxRecognitionDurationTimer: null,
      dtmfInterDigitTimer: null, dtmfFinalTimer: null,
      vadMaxWaitAfterPromptTimer: null, vadActivationDelayTimer: null, vadInitialSilenceDelayTimer: null,
    };
    this.activeCalls.set(callId, callResources);
    callLogger.info(`${logPrefix} Call resources initialized. Mode: ${callConfig.appConfig.appRecognitionConfig.recognitionActivationMode}`);

    try {
      callLogger.info(`${logPrefix} Attempting to answer incoming channel ${callId}.`);
      try {
        await incomingChannel.answer();
        callLogger.info(`${logPrefix} Successfully answered incoming channel ${callId}.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to answer incoming channel ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for answer failure:`, err);
        throw err;
      }
      incomingChannel.once('StasisEnd', () => {
        callLogger.info(`${logPrefix} Primary channel ${callId} StasisEnd. Cleanup.`);
        this._fullCleanup(callId, false, "PRIMARY_CHANNEL_STASIS_ENDED");
      });

      if (!this.client) { throw new Error("ARI client not connected."); }

      callLogger.info(`${logPrefix} Attempting to create userBridge for call ${callId}.`);
      try {
        callResources.userBridge = await this.client.bridges.create({ type: 'mixing', name: `user_b_${callId}` });
        callLogger.info(`${logPrefix} Successfully created userBridge ${callResources.userBridge.id} for call ${callId}.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to create userBridge for call ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for userBridge creation failure:`, err);
        throw err;
      }

      callLogger.info(`${logPrefix} Attempting to add channel ${callId} to userBridge ${callResources.userBridge.id}.`);
      try {
        await callResources.userBridge.addChannel({ channel: callId });
        callLogger.info(`${logPrefix} Successfully added channel ${callId} to userBridge ${callResources.userBridge.id}.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to add channel ${callId} to userBridge ${callResources.userBridge.id}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for addChannel to userBridge failure:`, err);
        throw err;
      }

      callLogger.info(`${logPrefix} Attempting to create snoopBridge for call ${callId}.`);
      try {
        callResources.snoopBridge = await this.client.bridges.create({ type: 'mixing', name: `snoop_b_${callId}` });
        callLogger.info(`${logPrefix} Successfully created snoopBridge ${callResources.snoopBridge.id} for call ${callId}.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to create snoopBridge for call ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for snoopBridge creation failure:`, err);
        throw err;
      }
      callResources.rtpServer = new RtpServer(callLogger.child({ component: 'RtpServer'}));
      callLogger.info(`${logPrefix} Attempting to start RTP server for call ${callId}.`);
      let rtpServerAddress: { host: string, port: number };
      try {
        rtpServerAddress = await callResources.rtpServer.start(0, DEFAULT_RTP_HOST_IP);
        callLogger.info(`${logPrefix} RTP Server started for call ${callId}, listening on ${rtpServerAddress.host}:${rtpServerAddress.port}.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to start RTP server for call ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for RTP server start failure:`, err);
        throw err;
      }

      const externalMediaFormat = 'ulaw';
      callLogger.info(`${logPrefix} Setting Asterisk externalMediaFormat to 'ulaw' for OpenAI G.711 passthrough.`);

      // actualAsteriskFormat and actualAsteriskSampleRate assignments removed from here

      callLogger.info(`${logPrefix} Attempting to create externalMediaChannel for call ${callId} (app: ${ASTERISK_ARI_APP_NAME}, host: ${rtpServerAddress.host}:${rtpServerAddress.port}, format: '${externalMediaFormat}', encapsulation: 'rtp').`);
      try {
        callResources.externalMediaChannel = await this.client.channels.externalMedia({
          app: ASTERISK_ARI_APP_NAME,
          external_host: `${rtpServerAddress.host}:${rtpServerAddress.port}`,
          format: externalMediaFormat,
          encapsulation: 'rtp'
        });
        callLogger.info(`${logPrefix} Successfully created externalMediaChannel ${callResources.externalMediaChannel.id} for call ${callId} with format ${externalMediaFormat}.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to create externalMediaChannel for call ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for externalMediaChannel creation failure:`, err);
        throw err;
      }
      this.appOwnedChannelIds.add(callResources.externalMediaChannel.id);

      const snoopDirection = 'out' as ('in' | 'out' | 'both');
      callLogger.info(`${logPrefix} Attempting to create snoopChannel on ${callId} (snoopId: snoop_${callId}, direction: '${snoopDirection}').`);
      try {
        callResources.snoopChannel = await this.client.channels.snoopChannelWithId({ channelId: callId, snoopId: `snoop_${callId}`, app: ASTERISK_ARI_APP_NAME, spy: snoopDirection });
        callLogger.info(`${logPrefix} Successfully created snoopChannel ${callResources.snoopChannel.id} for call ${callId} with direction '${snoopDirection}'.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to create snoopChannel for call ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for snoopChannel creation failure:`, err);
        throw err;
      }
      this.appOwnedChannelIds.add(callResources.snoopChannel.id);

      callLogger.info(`${logPrefix} Attempting to add externalMediaChannel ${callResources.externalMediaChannel.id} to snoopBridge ${callResources.snoopBridge.id}.`);
      try {
        await callResources.snoopBridge.addChannel({ channel: callResources.externalMediaChannel.id });
        callLogger.info(`${logPrefix} Successfully added externalMediaChannel ${callResources.externalMediaChannel.id} to snoopBridge ${callResources.snoopBridge.id}.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to add externalMediaChannel to snoopBridge for call ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for addChannel (externalMediaChannel) to snoopBridge failure:`, err);
        throw err;
      }

      callLogger.info(`${logPrefix} Attempting to add snoopChannel ${callResources.snoopChannel.id} to snoopBridge ${callResources.snoopBridge.id}.`);
      try {
        await callResources.snoopBridge.addChannel({ channel: callResources.snoopChannel.id });
        callLogger.info(`${logPrefix} Successfully added snoopChannel ${callResources.snoopChannel.id} to snoopBridge ${callResources.snoopBridge.id}.`);
      } catch (err: any) {
        callLogger.error(`${logPrefix} FAILED to add snoopChannel to snoopBridge for call ${callId}. Error: ${err.message || JSON.stringify(err)}`);
        callLogger.error(`${logPrefix} Full error object for addChannel (snoopChannel) to snoopBridge failure:`, err);
        throw err;
      }

      callResources.rtpServer.on('audioPacket', (audioPayload: Buffer) => {
        const call = this.activeCalls.get(callId);
        if (call && !call.isCleanupCalled) {
          const sessionLoggerForAudio = call.callLogger || console;
          sessionLoggerForAudio.debug(`[${call.channel.id}] Received raw audio packet from Asterisk, length: ${audioPayload.length}. Forwarding as is (u-law expected).`);

          if (call.openAIStreamingActive && !call.pendingVADBufferFlush) {
            sessionManager.sendAudioToOpenAI(callId, audioPayload); // Send original audioPayload
          }

          if (call.isVADBufferingActive) {
            if (call.vadAudioBuffer.length < MAX_VAD_BUFFER_PACKETS) {
              call.vadAudioBuffer.push(audioPayload);
            } else {
              const currentLogPrefixVAD = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
              call.callLogger.warn(`${currentLogPrefixVAD} VAD buffer limit. Shift.`);
              call.vadAudioBuffer.shift();
              call.vadAudioBuffer.push(audioPayload);
            }
          }
        }
      });

      sessionManager.handleCallConnection(callId, this);
      callLogger.info(`${logPrefix} Call connection details passed to SessionManager.`);

      const appRecogConf = callConfig.appConfig.appRecognitionConfig;
      if (appRecogConf.maxRecognitionDurationSeconds && appRecogConf.maxRecognitionDurationSeconds > 0) {
        callResources.maxRecognitionDurationTimer = setTimeout(() => { this._fullCleanup(callId, true, "MAX_RECOGNITION_DURATION_TIMEOUT"); }, appRecogConf.maxRecognitionDurationSeconds * 1000);
      }

      const activationMode = appRecogConf.recognitionActivationMode;
      if (activationMode === 'IMMEDIATE') { this._activateOpenAIStreaming(callId, "immediate_mode_on_start"); }
      else if (activationMode === 'VAD') {
        callResources.isVADBufferingActive = true;
        const vadConfig = appRecogConf.vadConfig;
        const talkDetectValue = `${vadConfig.vadRecognitionActivationMs},${vadConfig.vadSilenceThresholdMs}`;
        callLogger.info(`${logPrefix} Attempting to set TALK_DETECT on channel ${callId} with value: ${talkDetectValue}.`);
        try {
          await incomingChannel.setChannelVar({ variable: 'TALK_DETECT(set)', value: talkDetectValue });
          callLogger.info(`${logPrefix} Successfully set TALK_DETECT on channel ${callId}.`);
        } catch (err:any) {
          callLogger.error(`${logPrefix} FAILED to set TALK_DETECT for call ${callId}. Error: ${err.message || JSON.stringify(err)}`);
          callLogger.error(`${logPrefix} Full error object for TALK_DETECT set failure:`, err);
          throw err;
        }
        if (appRecogConf.vadRecogActivation === 'vadMode') {
          callResources.vadInitialSilenceDelayCompleted = (appRecogConf.vadInitialSilenceDelaySeconds ?? 0) <= 0;
          callResources.vadActivationDelayCompleted = (appRecogConf.vadActivationDelaySeconds ?? 0) <= 0;
          if (!callResources.vadInitialSilenceDelayCompleted) {
            callResources.vadInitialSilenceDelayTimer = setTimeout(() => { if(callResources.isCleanupCalled) return; callResources.vadInitialSilenceDelayCompleted = true; this._handleVADDelaysCompleted(callId); }, (appRecogConf.vadInitialSilenceDelaySeconds ?? 0) * 1000);
          }
          if (!callResources.vadActivationDelayCompleted) {
            callResources.vadActivationDelayTimer = setTimeout(() => { if(callResources.isCleanupCalled) return; callResources.vadActivationDelayCompleted = true; this._handleVADDelaysCompleted(callId); }, (appRecogConf.vadActivationDelaySeconds ?? 0) * 1000);
          }
          if (callResources.vadInitialSilenceDelayCompleted && callResources.vadActivationDelayCompleted) { this._handleVADDelaysCompleted(callId); }
        }
      }

      const greetingAudio = appRecogConf.greetingAudioPath;
      const call = callResources;
      if (greetingAudio && this.client) {
        callLogger.info(`${logPrefix} Playing greeting audio: ${greetingAudio}`);
        callResources.mainPlayback = this.client.Playback();

        if (callResources.mainPlayback) {
          const mainPlaybackId = callResources.mainPlayback.id;

          const playbackFailedHandler = (event: any, failedPlayback: Playback) => {
            if (this.client && failedPlayback.id === mainPlaybackId) {
              const currentCall = this.activeCalls.get(callId);
              if (currentCall && currentCall.mainPlayback && currentCall.mainPlayback.id === mainPlaybackId) {
                const currentLogPrefix = `[${currentCall.channel.id}][Caller: ${currentCall.channel.caller?.number || 'N/A'}]`;
                currentCall.callLogger.warn(`${currentLogPrefix} Main greeting playback ${failedPlayback.id} FAILED (client event). Reason: ${event.playback && event.playback.state === 'failed' ? (event.playback.reason || 'Unknown') : (event.reason || 'Unknown')}`);
                this._handlePlaybackFinished(callId, 'main_greeting_failed');
              }
              if (currentCall && currentCall.playbackFailedHandler) {
                this.client?.removeListener('PlaybackFailed' as any, currentCall.playbackFailedHandler);
                currentCall.playbackFailedHandler = null;
              }
            }
          };

          callResources.playbackFailedHandler = playbackFailedHandler;
          this.client.on('PlaybackFailed' as any, callResources.playbackFailedHandler);

          callResources.mainPlayback.once('PlaybackFinished', (evt: any, instance: Playback) => {
            const currentCall = this.activeCalls.get(callId);
            const currentLogPrefix = currentCall ? `[${currentCall.channel.id}][Caller: ${currentCall.channel.caller?.number || 'N/A'}]` : `[${callId}]`;
            if (currentCall && currentCall.playbackFailedHandler && this.client && instance.id === currentCall.mainPlayback?.id) {
              this.client.removeListener('PlaybackFailed' as any, currentCall.playbackFailedHandler);
              currentCall.playbackFailedHandler = null;
            }
            if (currentCall && instance.id === currentCall.mainPlayback?.id) {
              currentCall.callLogger.info(`${currentLogPrefix} Main greeting playback ${instance.id} FINISHED for call ${callId}.`);
              this._handlePlaybackFinished(callId, 'main_greeting_finished');
            }
          });
          try {
            callLogger.info(`${logPrefix} Attempting to play greeting audio '${greetingAudio}' on channel ${callId} using playback ID ${callResources.mainPlayback.id}.`);
            await callResources.channel.play({ media: greetingAudio }, callResources.mainPlayback);
            callLogger.info(`${logPrefix} Successfully started main greeting playback ${callResources.mainPlayback.id} on channel ${callId}.`);
          } catch (playError: any) {
            callLogger.error(`${logPrefix} FAILED to start main greeting playback for call ${callId}. Error: ${(playError instanceof Error ? playError.message : String(playError))}`);
            callLogger.error(`${logPrefix} Full error object for greeting playback failure:`, playError);
            this._handlePlaybackFinished(callId, 'main_greeting_playback_start_error');
          }
        } else {
           callLogger.error(`${logPrefix} Failed to create mainPlayback object.`);
           this._handlePlaybackFinished(callId, 'main_greeting_creation_failed');
        }
      } else {
        callLogger.info(greetingAudio ? `${logPrefix} Client not available for greeting playback.` : `${logPrefix} No greeting audio specified.`);
        if (activationMode === 'FIXED_DELAY') {
            const delaySeconds = appRecogConf.bargeInDelaySeconds ?? 0.5;
            if(delaySeconds > 0) { callResources.bargeInActivationTimer = setTimeout(() => { if(!callResources.isCleanupCalled) this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_timer"); }, delaySeconds * 1000); }
            else { this._activateOpenAIStreaming(callId, "fixedDelay_no_greeting_immediate");}
        } else if (activationMode === 'VAD') {
            this._handlePostPromptVADLogic(callId);
        }
      }
      callLogger.info(`${logPrefix} StasisStart setup complete for call ${callId}.`);
    } catch (err: any) {
      callLogger.error(`${logPrefix} Error in StasisStart for ${callId}: ${(err instanceof Error ? err.message : String(err))}`);
      await this._fullCleanup(callId, true, "STASIS_START_ERROR");
    }
  }

  private onAppOwnedChannelStasisEnd(event: any, channel: Channel): void { /* ... */ }
  private async onStasisEnd(event: any, channel: Channel): Promise<void> { /* ... */ }
  private _clearCallTimers(call: CallResources): void {
    if (call.bargeInActivationTimer) clearTimeout(call.bargeInActivationTimer);
    if (call.noSpeechBeginTimer) clearTimeout(call.noSpeechBeginTimer);
    if (call.initialOpenAIStreamIdleTimer) clearTimeout(call.initialOpenAIStreamIdleTimer);
    if (call.speechEndSilenceTimer) clearTimeout(call.speechEndSilenceTimer);
    if (call.maxRecognitionDurationTimer) clearTimeout(call.maxRecognitionDurationTimer);
    if (call.dtmfInterDigitTimer) clearTimeout(call.dtmfInterDigitTimer);
    if (call.dtmfFinalTimer) clearTimeout(call.dtmfFinalTimer);
    if (call.vadMaxWaitAfterPromptTimer) clearTimeout(call.vadMaxWaitAfterPromptTimer);
    if (call.vadActivationDelayTimer) clearTimeout(call.vadActivationDelayTimer);
    if (call.vadInitialSilenceDelayTimer) clearTimeout(call.vadInitialSilenceDelayTimer);
    call.bargeInActivationTimer = null;
    call.noSpeechBeginTimer = null;
    call.initialOpenAIStreamIdleTimer = null;
    call.speechEndSilenceTimer = null;
    call.maxRecognitionDurationTimer = null;
    call.dtmfInterDigitTimer = null;
    call.dtmfFinalTimer = null;
    call.vadMaxWaitAfterPromptTimer = null;
    call.vadActivationDelayTimer = null;
    call.vadInitialSilenceDelayTimer = null;
  }
  private async _fullCleanup(callId: string, hangupMainChannel: boolean, reason: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (call && call.isCleanupCalled) {
      return;
    }
    if (call) {
      const logPrefix = `[${call.channel?.id || callId}][Caller: ${call.channel?.caller?.number || 'N/A'}]`;
      call.isCleanupCalled = true;
      call.callLogger.info(`${logPrefix} Full cleanup initiated. Reason: ${reason}. Hangup main: ${hangupMainChannel}`);

      if (call.playbackFailedHandler && this.client) {
        this.client.removeListener('PlaybackFailed' as any, call.playbackFailedHandler);
        call.playbackFailedHandler = null;
      }
      if (call.waitingPlaybackFailedHandler && this.client) {
        this.client.removeListener('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);
        call.waitingPlaybackFailedHandler = null;
      }

      this._clearCallTimers(call);

      if (call.openAIStreamingActive || call.isOpenAIStreamEnding) {
        call.callLogger.info(`${logPrefix} Stopping OpenAI session due to cleanup.`);
        try {
          sessionManager.stopOpenAISession(callId, `cleanup_${reason}`);
        } catch (e:any) { call.callLogger.error(`${logPrefix} Error stopping OpenAI session during cleanup: ${e.message}`); }
      }
      call.openAIStreamingActive = false;
      call.isOpenAIStreamEnding = true;

      await this.cleanupCallResources(callId, hangupMainChannel, false, call.callLogger);

    } else {
      moduleLogger.warn(`[${callId}] _fullCleanup called for non-existent callId.`);
    }
  }
  private async cleanupCallResources(channelId: string, hangupChannel: boolean = false, isAriClosing: boolean = false, loggerInstance?: any ): Promise<void> {
    const call = this.activeCalls.get(channelId);
    const resolvedLogger = loggerInstance || this.logger.child({ callId: channelId, context: 'cleanupCallResources' });
    const logPrefix = call ? `[${call.channel?.id || channelId}][Caller: ${call.channel?.caller?.number || 'N/A'}]` : `[${channelId}]`;

    resolvedLogger.info(`${logPrefix} Starting cleanupCallResources.`);

    if (call?.rtpServer) {
      resolvedLogger.info(`${logPrefix} Stopping RTP server.`);
      try { await call.rtpServer.stop(); }
      catch (e:any) { resolvedLogger.error(`${logPrefix} Error stopping RTP server: ${e.message}`); }
      call.rtpServer = undefined;
    }

    const channelsToHangup: (Channel | undefined)[] = [];
    if (call?.snoopChannel) {
      resolvedLogger.info(`${logPrefix} Cleaning up snoopChannel ${call.snoopChannel.id}.`);
      if (!isAriClosing) { channelsToHangup.push(call.snoopChannel); }
      this.appOwnedChannelIds.delete(call.snoopChannel.id);
      call.snoopChannel = undefined;
    }
    if (call?.externalMediaChannel) {
      resolvedLogger.info(`${logPrefix} Cleaning up externalMediaChannel ${call.externalMediaChannel.id}.`);
      if (!isAriClosing) { channelsToHangup.push(call.externalMediaChannel); }
      this.appOwnedChannelIds.delete(call.externalMediaChannel.id);
      call.externalMediaChannel = undefined;
    }

    for (const ch of channelsToHangup) {
      if (ch) {
        try {
          resolvedLogger.info(`${logPrefix} Attempting to hangup app-owned channel ${ch.id}.`);
          await ch.hangup();
          resolvedLogger.info(`${logPrefix} Successfully hung up app-owned channel ${ch.id}.`);
        } catch (e:any) { resolvedLogger.warn(`${logPrefix} Error hanging up app-owned channel ${ch.id}: ${e.message} (might be already hung up).`); }
      }
    }

    if (call?.snoopBridge) {
      resolvedLogger.info(`${logPrefix} Destroying snoopBridge ${call.snoopBridge.id}.`);
      try { await call.snoopBridge.destroy(); }
      catch (e:any) { resolvedLogger.error(`${logPrefix} Error destroying snoopBridge: ${e.message}`); }
      call.snoopBridge = undefined;
    }
    if (call?.userBridge) {
      resolvedLogger.info(`${logPrefix} Destroying userBridge ${call.userBridge.id}.`);
      try { await call.userBridge.destroy(); }
      catch (e:any) { resolvedLogger.error(`${logPrefix} Error destroying userBridge: ${e.message}`); }
      call.userBridge = undefined;
    }

    if (hangupChannel && call?.channel) {
      try {
        resolvedLogger.info(`${logPrefix} Attempting to hangup main channel ${call.channel.id}.`);
        await call.channel.hangup();
        resolvedLogger.info(`${logPrefix} Main channel ${call.channel.id} hung up successfully.`);
      } catch (e: any) {
        resolvedLogger.error(`${logPrefix} Error hanging up main channel ${call.channel.id}: ${e.message} (might be already hung up or StasisEnd occurred).`);
      }
    }

    if (call) {
        this.activeCalls.delete(channelId);
        sessionManager.handleAriCallEnd(channelId);
        resolvedLogger.info(`${logPrefix} Call resources fully cleaned up and removed from active sessions.`);
    } else if (!isAriClosing) {
        resolvedLogger.warn(`${logPrefix} cleanupCallResources: No call object found for channelId ${channelId} during cleanup.`);
    }
  }
  private onAriError(err: any): void {
    this.logger.error('General ARI Client Error:', err);
   }
  private onAriClose(): void {
    this.logger.info('ARI connection closed. Cleaning up all active calls.');
    const callIds = Array.from(this.activeCalls.keys());
    for (const callId of callIds) {
        const call = this.activeCalls.get(callId);
        if (call) {
            const logPrefix = `[${call.channel?.id || callId}][Caller: ${call.channel?.caller?.number || 'N/A'}]`;
            call.callLogger.warn(`${logPrefix} ARI connection closed, forcing cleanup for this call.`);
            this._fullCleanup(callId, true, "ARI_CONNECTION_CLOSED");
        }
    }
    this.activeCalls.clear();
    this.appOwnedChannelIds.clear();
   }
  public async playbackAudio(channelId: string, audioPayloadB64: string): Promise<void> {
    const call = this.activeCalls.get(channelId);
    if (!call || call.isCleanupCalled || !this.client) {
      (call?.callLogger || this.logger).warn(`[${channelId}] Cannot playback audio, call not active or client missing.`);
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.debug(`${logPrefix} Attempting to play audio chunk of length ${audioPayloadB64.length}.`);
    try {
      if (call.waitingPlayback) {
        try {
          await call.waitingPlayback.stop();
          call.callLogger.debug(`${logPrefix} Stopped previous waiting playback.`);
        }
        catch(e:any) { call.callLogger.warn(`${logPrefix} Error stopping previous waiting playback: ${e.message}`);}
        call.waitingPlayback = undefined;
      }

      call.waitingPlayback = this.client.Playback();
      const playbackId = call.waitingPlayback.id;
      const currentCallId = call.channel.id;
      call.callLogger.debug(`${logPrefix} Created playback object ${playbackId}.`);

      const waitingPlaybackFinishedCb = () => {
        const currentCall = this.activeCalls.get(currentCallId);
        if (!currentCall) return;
        const cbLogPrefix = `[${currentCall.channel.id}][Caller: ${currentCall.channel.caller?.number || 'N/A'}]`;
        currentCall.callLogger.debug(`${cbLogPrefix} Playback ${playbackId} finished.`);
        if(currentCall.waitingPlayback && currentCall.waitingPlayback.id === playbackId) {
          currentCall.waitingPlayback = undefined;
        }
        if (this.client && currentCall.waitingPlaybackFailedHandler) {
          this.client.removeListener('PlaybackFailed' as any, currentCall.waitingPlaybackFailedHandler);
          currentCall.waitingPlaybackFailedHandler = null;
        }
      };
      if (call.waitingPlayback) {
          call.waitingPlayback.once('PlaybackFinished', waitingPlaybackFinishedCb);
      }

      const waitingPlaybackFailedCb = (event: any, failedPlayback: Playback) => {
        if (this.client && failedPlayback.id === playbackId) {
          const currentCall = this.activeCalls.get(currentCallId);
          if (!currentCall) return;
          const cbLogPrefix = `[${currentCall.channel.id}][Caller: ${currentCall.channel.caller?.number || 'N/A'}]`;
          currentCall.callLogger.error(`${cbLogPrefix} Playback ${playbackId} failed: ${failedPlayback?.state}, ${event?.message || (event?.playback?.reason || 'Unknown')}`);
          if(currentCall.waitingPlayback && currentCall.waitingPlayback.id === playbackId) {
            currentCall.waitingPlayback = undefined;
          }
          this.client.removeListener('PlaybackFailed' as any, waitingPlaybackFailedCb);
          if (currentCall.waitingPlaybackFailedHandler === waitingPlaybackFailedCb) {
              currentCall.waitingPlaybackFailedHandler = null;
          }
        }
      };
      call.waitingPlaybackFailedHandler = waitingPlaybackFailedCb;
      this.client.on('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);

      await call.channel.play({ media: `sound:base64:${audioPayloadB64}` }, call.waitingPlayback);
      call.callLogger.debug(`${logPrefix} Playback ${playbackId} started.`);
    } catch (err: any) {
      call.callLogger.error(`${logPrefix} Error playing audio: ${err.message || JSON.stringify(err)}`);
      if (call.waitingPlayback) {
        if (call.waitingPlaybackFailedHandler && this.client) {
            this.client.removeListener('PlaybackFailed' as any, call.waitingPlaybackFailedHandler);
            call.waitingPlaybackFailedHandler = null;
        }
        call.waitingPlayback = undefined;
      }
    }
  }
  public async endCall(channelId: string): Promise<void> {
    const call = this.activeCalls.get(channelId);
    if (!call) {
      this.logger.warn(`[${channelId}] Attempted to end non-existent call.`);
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} endCall invoked. Initiating full cleanup.`);
    await this._fullCleanup(channelId, true, "EXPLICIT_ENDCALL_REQUEST");
  }

  private async _playTTSToCaller(callId: string, textToSpeak: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call || call.isCleanupCalled) {
      (call?.callLogger || this.logger).warn(`[${callId}] Cannot play TTS, call not active or cleanup called.`);
      return;
    }
    const logPrefix = `[${call.channel.id}][Caller: ${call.channel.caller?.number || 'N/A'}]`;
    call.callLogger.info(`${logPrefix} Requesting TTS for text: "${textToSpeak}"`);

    try {
      // @ts-ignore
      const audioBuffer = await sessionManager.synthesizeSpeechOpenAI(call.config, textToSpeak, call.callLogger);

      if (audioBuffer && audioBuffer.length > 0) {
        const audioBase64 = audioBuffer.toString('base64');
        call.callLogger.info(`${logPrefix} TTS audio received (${audioBuffer.length} bytes). Playing to caller.`);
        await this.playbackAudio(callId, audioBase64);
      } else {
        call.callLogger.error(`${logPrefix} TTS synthesis failed or returned empty audio.`);
      }
    } catch (error: any) {
      call.callLogger.error(`${logPrefix} Error during TTS synthesis or playback: ${error.message}`, error);
    }
  }
}

let ariClientServiceInstance: AriClientService | null = null;
export async function initializeAriClient(): Promise<AriClientService> {
  if (!OPENAI_API_KEY) {
      moduleLogger.error("FATAL: Cannot initialize AriClientService - OPENAI_API_KEY is not set.");
      throw new Error("OPENAI_API_KEY is not set. Server cannot start.");
  }
  if (!ariClientServiceInstance) {
    ariClientServiceInstance = new AriClientService();
    await ariClientServiceInstance.connect();
  }
  return ariClientServiceInstance;
}

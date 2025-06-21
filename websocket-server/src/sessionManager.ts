import { RawData, WebSocket } from "ws";
// Use named import as shown in the user's example for `g711`
import { ulawToPCM } from 'g711';
import config from 'config';
import * as fs from 'fs';
import * as path from 'path';
import functions from "./functionHandlers"; // Assuming this is still needed for other parts
import { CallSpecificConfig, AriClientInterface, Logger } from "./types";
import { AriClientService } from "./ari-client";


// Define a type/interface for storing session information
interface OpenAISession {
  ws: WebSocket;
  ariClient: AriClientInterface; // This is the generic interface
  callId: string;
  config: CallSpecificConfig; // Contains OpenAIRealtimeAPIConfig and other call settings
  logger: Logger;
}

// Centralized map for active OpenAI Realtime sessions
const activeOpenAISessions = new Map<string, OpenAISession>();

interface CallSessionData {
  callId: string;
  ariClient: AriClientService;
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  lastAssistantItemId?: string;
  responseStartTimestamp?: number;
}
const activeSessions = new Map<string, CallSessionData>(); // Legacy session map


function getLegacySession(callId: string, operation: string): CallSessionData | undefined {
  const session = activeSessions.get(callId);
  if (!session) {
    // console.warn(`SessionManager (Legacy): ${operation} - No active legacy session found for callId ${callId}.`);
  }
  return session;
}

export function handleCallConnection(callId: string, ariClient: AriClientService, logger: Logger) {
  if (activeSessions.has(callId)) {
    logger.warn(`SessionManager (Legacy): Call connection for ${callId} already in legacy map. Overwriting ariClient link.`);
  }
  logger.info(`SessionManager: Initializing legacy session data placeholder for call: ${callId}`);
  const newLegacySessionData: Partial<CallSessionData> = {
    callId,
    ariClient,
  };
  activeSessions.set(callId, newLegacySessionData as CallSessionData);
}


export function startOpenAISession(callId: string, ariClient: AriClientInterface, callConfig: CallSpecificConfig): void {
  const sessionLogger = ariClient.logger || console;
  sessionLogger.info(`SessionManager: Attempting to start OpenAI Realtime session for callId ${callId}.`);

  if (activeOpenAISessions.has(callId)) {
    sessionLogger.warn(`SessionManager: OpenAI Realtime session for ${callId} already exists. Closing old one.`);
    const oldSession = activeOpenAISessions.get(callId);
    if (oldSession?.ws && oldSession.ws.readyState === WebSocket.OPEN) {
      oldSession.ws.close(1000, "Starting new session");
    }
    activeOpenAISessions.delete(callId);
  }

  const apiKey = process.env.OPENAI_API_KEY || config.get<string>('openai.apiKey');
  if (!apiKey || apiKey === "YOUR_OPENAI_API_KEY") {
    sessionLogger.error(`SessionManager: CRITICAL - OPENAI_API_KEY not found or not configured. Cannot start session for ${callId}.`);
    ariClient._onOpenAIError(callId, new Error("OPENAI_API_KEY not configured on server."));
    return;
  }

  const openAIConfig = callConfig.openAIRealtimeAPI;

  const baseUrl = "wss://api.openai.com/v1/realtime";
  let wsQueryString = `?model=${openAIConfig.model}`;

  const wsUrl = baseUrl + wsQueryString;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'OpenAI-Beta': 'realtime=v1'
  };

  sessionLogger.debug(`[${callId}] Connecting to OpenAI Realtime WebSocket: ${wsUrl.replace(apiKey, "****")}`);
  const ws = new WebSocket(wsUrl, { headers });

  const newSession: OpenAISession = { ws, ariClient, callId, config: callConfig, logger: sessionLogger };
  activeOpenAISessions.set(callId, newSession);

  ws.on('open', () => {
    sessionLogger.info(`SessionManager: OpenAI Realtime WebSocket connection established for callId ${callId}.`);

    let modalitiesArrayInternal: ('audio' | 'text')[] = ['audio', 'text'];
    const modalitiesConfigValue = openAIConfig.responseModalities;

    if (typeof modalitiesConfigValue === 'string') {
        modalitiesArrayInternal = modalitiesConfigValue.split(',')
                                     .map((m: string) => m.trim().toLowerCase())
                                     .filter((m: string) => m === 'audio' || m === 'text') as ('audio' | 'text')[];
    } else if (Array.isArray(modalitiesConfigValue)) {
        modalitiesArrayInternal = modalitiesConfigValue.filter((m: any): m is ('audio' | 'text') => m === 'audio' || m === 'text');
    }
    if (modalitiesArrayInternal.length === 0) {
        modalitiesArrayInternal = ['audio', 'text'];
    }

    const sessionUpdatePayload = {
      type: "session.update",
      session: {
        input_audio_format: openAIConfig.inputAudioFormat,
        output_audio_format: openAIConfig.outputAudioFormat,
        voice: openAIConfig.ttsVoice,
        instructions: openAIConfig.instructions_es || openAIConfig.instructions,
        modalities: modalitiesArrayInternal,
      }
    };

    sessionLogger.debug(`[${callId}] OpenAI Realtime: Sending session.update event:`, sessionUpdatePayload);
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(sessionUpdatePayload));
        sessionLogger.info(`OpenAI Realtime: Sent session.update event for callId ${callId}`);
      } catch (e: any) {
        sessionLogger.error(`OpenAI Realtime: Failed to send session.update event for callId ${callId}: ${e.message}`);
      }
    }
  });

  ws.on('message', (data: RawData) => {
    let messageContent: string = '';
    const currentSession = activeOpenAISessions.get(callId);
    if (!currentSession) return;

    const currentAriClient = currentSession.ariClient;
    const msgSessionLogger = currentSession.logger;

    if (Buffer.isBuffer(data)) {
      messageContent = data.toString('utf8');
    } else if (Array.isArray(data)) {
      try {
        messageContent = Buffer.concat(data).toString('utf8');
      } catch (e: any) {
        msgSessionLogger.error(`OpenAI Realtime WebSocket: Error concatenating Buffer array for callId ${callId}: ${e.message}`);
        messageContent = '';
      }
    } else if (data instanceof ArrayBuffer) {
      messageContent = Buffer.from(data).toString('utf8');
    } else {
        messageContent = String(data);
        msgSessionLogger.warn(`OpenAI Realtime WebSocket: Received data of non-standard type (converted to string) for callId ${callId}. Type: ${typeof data}`);
    }

    msgSessionLogger.debug(`[${callId}] OpenAI Raw Server Message: ${messageContent}`);
    if (messageContent && messageContent.trim().length > 0) {
      try {
        const serverEvent = JSON.parse(messageContent);
        msgSessionLogger.debug(`[${callId}] OpenAI Parsed Server Event:`, serverEvent);

        switch (serverEvent.type) {
          case 'session.created':
            msgSessionLogger.info(`OpenAI session.created for ${callId}: ${JSON.stringify(serverEvent.session)}`);
            break;
          case 'session.updated':
            msgSessionLogger.info(`OpenAI session.updated for ${callId}: ${JSON.stringify(serverEvent.session)}`);
            break;
          case 'response.text.delta':
            if (serverEvent.delta && typeof serverEvent.delta.text === 'string') {
              currentAriClient._onOpenAIInterimResult(callId, serverEvent.delta.text);
            }
            break;
          case 'response.done':
            msgSessionLogger.info(`OpenAI response.done for ${callId}.`);
            let finalTranscriptText = "";
            if (serverEvent.response && serverEvent.response.output && serverEvent.response.output.length > 0) {
                const textOutput = serverEvent.response.output.find((item: any) => item.type === 'text_content' || (item.content && item.content.find((c:any) => c.type === 'text')));
                if (textOutput) {
                    if (textOutput.type === 'text_content') finalTranscriptText = textOutput.text;
                    else if (textOutput.content) {
                        const textPart = textOutput.content.find((c:any) => c.type === 'text');
                        if (textPart) finalTranscriptText = textPart.text;
                    }
                } else {
                    const altTextOutput = serverEvent.response.output.find((item:any) => item.transcript);
                    if (altTextOutput) finalTranscriptText = altTextOutput.transcript;
                }
            }
            if (finalTranscriptText) {
              currentAriClient._onOpenAIFinalResult(callId, finalTranscriptText);
            } else {
                msgSessionLogger.warn(`[${callId}] No final transcript text found in response.done event.`);
            }
            break;
          case 'response.audio.delta':
            if (serverEvent.delta && typeof serverEvent.delta.audio === 'string') {
              if (typeof currentAriClient._onOpenAIAudioChunk === 'function') {
                   currentAriClient._onOpenAIAudioChunk(callId, serverEvent.delta.audio, false);
              } else {
                   msgSessionLogger.warn("ariClient._onOpenAIAudioChunk is not implemented.");
              }
            }
            break;
          case 'response.audio.done':
            msgSessionLogger.info(`OpenAI response.audio.done for ${callId}.`);
            if (typeof currentAriClient._onOpenAIAudioChunk === 'function') {
                currentAriClient._onOpenAIAudioChunk(callId, "", true);
            }
            break;
          case 'input_audio_buffer.speech_started':
               msgSessionLogger.info(`OpenAI detected speech started for ${callId}`);
               currentAriClient._onOpenAISpeechStarted(callId);
               break;
          case 'input_audio_buffer.speech_stopped':
               msgSessionLogger.info(`OpenAI detected speech stopped for ${callId}`);
               break;
          case 'error':
            msgSessionLogger.error(`OpenAI Server Error for ${callId}:`, serverEvent.error || serverEvent);
            currentAriClient._onOpenAIError(callId, new Error(JSON.stringify(serverEvent.error || serverEvent)));
            break;
          default:
            msgSessionLogger.debug(`OpenAI: Unhandled event type '${serverEvent.type}' for ${callId}. Full event:`, serverEvent);
        }
      } catch (e: any) {
        msgSessionLogger.error(`OpenAI Realtime WebSocket: Error parsing JSON message for callId ${callId}: ${e.message}. Raw content: "${messageContent}"`);
        currentAriClient._onOpenAIError(callId, new Error(`Failed to process STT message: ${e.message}`));
      }
    }
  });

  ws.on('error', (error: Error) => {
    sessionLogger.error(`SessionManager: OpenAI Realtime WebSocket error for callId ${callId}:`, error);
    ariClient._onOpenAIError(callId, error);
    activeOpenAISessions.delete(callId);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    const reasonStr = reason.toString() || "Unknown reason";
    sessionLogger.info(`SessionManager: OpenAI Realtime WebSocket closed for callId ${callId}. Code: ${code}, Reason: ${reasonStr}`);
    const closedSession = activeOpenAISessions.get(callId);
    if (closedSession) {
        closedSession.ariClient._onOpenAISessionEnded(callId, reasonStr);
        activeOpenAISessions.delete(callId);
    }
  });
}

export function stopOpenAISession(callId: string, reason: string): void {
  const session = activeOpenAISessions.get(callId);
  const loggerToUse = session?.logger || console;
  loggerToUse.info(`SessionManager: Request to stop OpenAI Realtime session for callId ${callId}. Reason: ${reason}`);
  if (session) {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      loggerToUse.info(`SessionManager: Closing OpenAI Realtime WebSocket for ${callId}.`);
      session.ws.close(1000, reason);
    } else {
      loggerToUse.info(`SessionManager: OpenAI Realtime WebSocket for ${callId} was already closing or not in OPEN state.`);
    }
  } else {
    loggerToUse.warn(`SessionManager: stopOpenAISession called for ${callId}, but no active Realtime session data found.`);
  }
}


export function processAndForwardAudio(callId: string, ulawAudioBuffer: Buffer): void {
    const session = activeOpenAISessions.get(callId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const { logger, config: callConfig } = session;

    const audioCaptureConfig = callConfig.audioCapture;
    if (audioCaptureConfig && audioCaptureConfig.enabled) {
        const outputDir = audioCaptureConfig.path || path.join(__dirname, '..', '..', 'captured_audio');
        if (!fs.existsSync(outputDir)) {
            try {
                fs.mkdirSync(outputDir, { recursive: true });
            } catch (e: any) {
                logger.error(`[${callId}] Error creating audio capture directory ${outputDir}: ${e.message}`);
            }
        }
        if (fs.existsSync(outputDir)) {
            const filePath = path.join(outputDir, `${callId}_${Date.now()}.ulaw`);
            fs.appendFile(filePath, ulawAudioBuffer, (err) => {
                if (err) {
                    logger.error(`[${callId}] Error writing captured u-law audio to ${filePath}: ${err.message}`);
                }
            });
        }
    }

    try {
        // Using the imported ulawToPCM function directly and specifying 16-bit output
        // Adding type assertion due to persistent TS2322, assuming .d.ts is incorrect for g711 package.
        const pcm8kHzInt16Samples = ulawToPCM(ulawAudioBuffer, 16) as any as Int16Array;

        const numInputSamples = pcm8kHzInt16Samples.length;
        if (numInputSamples === 0) {
            logger.warn(`[${callId}] Received empty u-law buffer, skipping conversion.`);
            return;
        }
        const numOutputSamples = numInputSamples * 3;
        const pcm24kHzSamples = new Int16Array(numOutputSamples);

        for (let i = 0; i < numInputSamples; i++) {
            const currentSample = pcm8kHzInt16Samples[i];
            const nextSample = (i + 1 < numInputSamples) ? pcm8kHzInt16Samples[i + 1] : currentSample;

            pcm24kHzSamples[i * 3] = currentSample;
            pcm24kHzSamples[i * 3 + 1] = Math.round(currentSample * (2/3) + nextSample * (1/3));
            pcm24kHzSamples[i * 3 + 2] = Math.round(currentSample * (1/3) + nextSample * (2/3));
        }

        const pcm24kHzBuffer = Buffer.alloc(pcm24kHzSamples.length * 2);
        for (let i = 0; i < pcm24kHzSamples.length; i++) {
            pcm24kHzBuffer.writeInt16LE(pcm24kHzSamples[i], i * 2);
        }

        if (pcm24kHzBuffer.length > 0) {
            sendAudioToOpenAI(callId, pcm24kHzBuffer);
        } else {
            logger.warn(`[${callId}] Converted PCM 24kHz buffer is empty. Original u-law length: ${ulawAudioBuffer.length}`);
        }
    } catch (error: any) {
        logger.error(`[${callId}] Error during audio conversion/processing: ${error.message}`, error.stack);
    }
}

function sendAudioToOpenAI(callId: string, pcm24kHzBuffer: Buffer): void {
  const session = activeOpenAISessions.get(callId);
  if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
    const { logger } = session;
    const base64AudioChunk = pcm24kHzBuffer.toString('base64');
    const audioEvent = { type: 'input_audio_buffer.append', audio: base64AudioChunk };
    try {
      session.ws.send(JSON.stringify(audioEvent));
    } catch (e:any) {
      logger.error(`[${callId}] Error sending audio event to OpenAI: ${e.message}`);
    }
  }
}

export function requestOpenAIResponse(callId: string, transcript: string): void {
  const session = activeOpenAISessions.get(callId);
  if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
    (session?.logger || console).error(`[${callId}] Cannot request OpenAI response: session not found or WebSocket not open.`);
    return;
  }
  const { logger, config: callConfig } = session;

  try {
    const conversationItemCreateEvent = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: transcript }]
      }
    };
    logger.debug(`[${callId}] OpenAI Realtime: Sending conversation.item.create event:`, conversationItemCreateEvent);
    session.ws.send(JSON.stringify(conversationItemCreateEvent));
    logger.info(`[${callId}] Sent conversation.item.create with user transcript.`);

    let modalitiesArrayInternal: ('audio' | 'text')[] = ['audio', 'text'];
    const modalitiesConfigValue = callConfig.openAIRealtimeAPI.responseModalities;

    if (typeof modalitiesConfigValue === 'string') {
        modalitiesArrayInternal = modalitiesConfigValue.split(',')
                                     .map((m: string) => m.trim().toLowerCase())
                                     .filter((m: string) => m === 'audio' || m === 'text') as ('audio' | 'text')[];
    } else if (Array.isArray(modalitiesConfigValue)) {
        modalitiesArrayInternal = modalitiesConfigValue.filter((m: any): m is ('audio' | 'text') => m === 'audio' || m === 'text');
    }
    if (modalitiesArrayInternal.length === 0) {
        modalitiesArrayInternal = ['audio', 'text'];
    }

    const responseCreateEvent = {
      type: "response.create",
      response: {
        modalities: modalitiesArrayInternal,
      }
    };
    logger.debug(`[${callId}] OpenAI Realtime: Sending response.create event:`, responseCreateEvent);
    session.ws.send(JSON.stringify(responseCreateEvent));
    logger.info(`[${callId}] Sent response.create requesting modalities: ${JSON.stringify(responseCreateEvent.response.modalities)}`);

  } catch (e:any) {
    logger.error(`[${callId}] Error sending request for OpenAI response: ${e.message}`);
  }
}

export function handleAriCallEnd(callId: string) {
  const session = activeOpenAISessions.get(callId);
  const loggerToUse = session?.logger || console;
  loggerToUse.info(`SessionManager: ARI call ${callId} ended. Cleaning up associated OpenAI Realtime session data.`);

  if (session) {
    if (session.ws && (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) ) {
      loggerToUse.info(`SessionManager: Closing active OpenAI Realtime connection for ended call ${callId}.`);
      session.ws.close(1000, "Call ended");
    }
  }

  const oldSession = getLegacySession(callId, "handleAriCallEnd");
  if (oldSession) {
    if (isOpen(oldSession.modelConn)) {
      loggerToUse.info(`SessionManager (Legacy): Closing any active old model connection for ended call ${callId}.`);
      oldSession.modelConn.close();
    }
    if (oldSession.frontendConn && isOpen(oldSession.frontendConn)) {
         jsonSend(oldSession.frontendConn, {type: "call_ended", callId: callId });
    }
    activeSessions.delete(callId);
    loggerToUse.info(`SessionManager (Legacy): Old legacy session data for callId ${callId} fully removed.`);
  }

  if (!session && !oldSession) {
    loggerToUse.warn(`SessionManager: Received ARI call end for callId ${callId}, but no session data was found (already cleaned up or never existed).`);
  }
}

let globalFrontendConn: WebSocket | undefined;
export function handleFrontendConnection(ws: WebSocket) {
  if (isOpen(globalFrontendConn)) globalFrontendConn.close();
  globalFrontendConn = ws;
  console.log("SessionManager (Legacy): Global frontend WebSocket client connected.");
  ws.on("message", (data) => handleFrontendMessage(null, data));
  ws.on("close", () => {
    globalFrontendConn = undefined;
    console.log("SessionManager (Legacy): Global frontend WebSocket client disconnected.");
  });
}

function handleFrontendMessage(callId: string | null, data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;
  const targetCallId = msg.callId || callId;

  if (targetCallId) {
    const session = getLegacySession(targetCallId, "handleFrontendMessageTargeted");
    if (session && isOpen(session.modelConn) && msg.type !== "session.update") {
      jsonSend(session.modelConn, msg);
    } else if (session && msg.type === "session.update") {
      console.log(`SessionManager (Legacy TODO): Received session.update from frontend for call ${targetCallId}:`, msg.session);
    }
  } else if (msg.type === "session.update") {
      console.log("SessionManager (Legacy TODO): Received global session.update from frontend:", msg.session);
  }
}

function handleModelMessage(callId: string, data: RawData) {
  const session = getLegacySession(callId, "handleModelMessage");
  if (!session) return;

  const event = parseMessage(data);
  if (!event) {
    console.error(`SessionManager (Legacy): Failed to parse JSON message from old OpenAI model for call ${callId}:`, data.toString());
    return;
  }
  console.debug(`[${callId}] (Legacy) Received message from old OpenAI model: type '${event?.type}'`);
  jsonSend(globalFrontendConn || session.frontendConn, event);

  switch (event.type) {
    case "transcript":
      console.info(`[${callId}] (Legacy) Old OpenAI transcript (is_final: ${event.is_final}): ${event.text}`);
      break;
    case "error":
        console.error(`[${callId}] (Legacy) Old OpenAI model error: ${event.message}`);
        break;
  }
}

async function handleFunctionCall(callId: string, item: { name: string; arguments: string, call_id?: string }) {
  console.log(`SessionManager (Legacy): Handling function call '${item.name}' for callId ${callId}. Args: ${item.arguments}`);
  const fnDef = functions.find((f) => f.schema.name === item.name);
  if (!fnDef) {
    const errorMsg = `(Legacy) No handler found for function '${item.name}' (callId: ${callId}).`;
    console.error(`SessionManager: ${errorMsg}`);
    throw new Error(errorMsg);
  }
  try {
    const args = JSON.parse(item.arguments);
    return await fnDef.handler(args);
  } catch (err: any) {
    console.error(`SessionManager (Legacy): Error parsing arguments or executing function '${item.name}' for ${callId}:`, err);
    return JSON.stringify({ error: `Error in function ${item.name}: ${err.message}` });
  }
}

function closeModelConnection(callId: string) {
  const session = activeSessions.get(callId);
  if (session) {
    session.modelConn = undefined;
  }
}

function parseMessage(data: RawData): any {
  try {
    const messageString = Buffer.isBuffer(data) ? data.toString() : (Array.isArray(data) ? Buffer.concat(data).toString() : String(data));
    return JSON.parse(messageString);
  }
  catch (e) {
    console.error("SessionManager: Failed to parse incoming JSON message:", data.toString(), e);
    return null;
  }
}
function jsonSend(ws: WebSocket | undefined, obj: unknown) {
  if (isOpen(ws)) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e: any) {
      console.error(`SessionManager: Error sending JSON message: ${e.message}`);
    }
  }
}
function isOpen(ws?: WebSocket): ws is WebSocket { return !!ws && ws.readyState === WebSocket.OPEN; }

export function handleFrontendDisconnection() {
    if(isOpen(globalFrontendConn)) {
        globalFrontendConn.close();
    }
    globalFrontendConn = undefined;
    console.log("SessionManager (Legacy): Global frontend WebSocket connection has been reset/cleared.");
}

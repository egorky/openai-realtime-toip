# OpenAI Realtime API with Asterisk ARI Quickstart

Combine OpenAI's Realtime API and Asterisk's telephony capabilities (via ARI - Asterisk REST Interface) to build an AI calling assistant.

<img width="1728" alt="Screenshot 2024-12-18 at 4 59 30 PM" src="https://github.com/user-attachments/assets/d3c8dcce-b339-410c-85ca-864a8e0fc326" />

## Quick Setup

Open two terminal windows for the `webapp` and `websocket-server`. Ensure your Asterisk server is configured and running.

| Component             | Purpose                                       | Quick Reference (see below for more) |
| --------------------- | --------------------------------------------- | ------------------------------------ |
| `webapp`              | Frontend for call configuration & transcripts | `npm run dev`                        |
| `websocket-server`    | Backend handling Asterisk & OpenAI connection | `npm run dev`                        |
| Asterisk              | Telephony server                              | (Must be running and configured)     |
| SIP Client/Softphone  | To place calls into Asterisk                  | (Configure to connect to Asterisk)   |

Make sure all environment variables in `webapp/.env` and `websocket-server/.env` are set correctly. See [Full Setup and Configuration](#full-setup-and-configuration) section for more.

## Overview

This repository implements a phone calling assistant using OpenAI's Realtime API and Asterisk. It has two main software components: the `webapp` and the `websocket-server`.

1.  **`webapp`**: A Next.js application serving as a frontend to configure call parameters (like instructions for the AI) and display live transcripts and function call interactions.
2.  **`websocket-server`**: An Express backend that:
    *   Connects to Asterisk via ARI (`ari-client.ts`).
    *   Manages incoming calls from Asterisk.
    *   Sets up RTP media streams to receive audio from Asterisk.
    *   Handles the Realtime API connection with OpenAI (`sessionManager.ts`).
    *   Forwards audio from Asterisk to OpenAI for transcription.
    *   Plays back audio responses from OpenAI to Asterisk.
    *   Forwards events (transcripts, function calls, errors) to the `webapp` via a WebSocket connection.
    *   Supports detailed operational modes (e.g., Immediate, FixedDelay, VAD with sub-modes 'vadMode'/'afterPrompt', and DTMF handling) to control speech recognition activation and interaction. Refer to `websocket-server/README.md` for specifics on these modes and their associated timer logic.

**Call Flow:**

1.  A call is placed to an extension on your Asterisk server.
2.  Asterisk dialplan routes the call to a `Stasis` application, which is handled by `ari-client.ts` in the `websocket-server`.
3.  `ari-client.ts` answers the call and establishes media handling:
    *   It creates an RTP server (`rtp-server.ts`) to receive audio from Asterisk.
    *   It instructs Asterisk (via ARI) to send call audio to this RTP server using an "external media" channel. It also sets up Asterisk's VAD (Voice Activity Detection) feature (`TALK_DETECT`) on the channel if VAD mode is enabled.
4.  Based on the configured `recognitionActivationMode` (e.g., immediate, fixed delay after greeting, VAD), `ari-client.ts` instructs `sessionManager.ts` to connect to OpenAI's Realtime API. This connection is configured with appropriate audio formats (e.g., G.711 µ-law).
5.  When `ari-client.ts` determines that OpenAI streaming should be active (e.g., after VAD detects speech, or a delay timer expires), audio received by `rtp-server.ts` is forwarded by `ari-client.ts` to `sessionManager.ts`, which then sends it to OpenAI. If VAD is used, initial audio might be buffered by `ari-client.ts` and flushed once the OpenAI stream is ready.
6.  OpenAI processes the audio, sending back events like speech started, interim and final transcripts, function call requests, and audio responses. DTMF input from the user can interrupt this process.
7.  `sessionManager.ts` receives these events from OpenAI and forwards them to `ari-client.ts` using specific callback methods (e.g., `_onOpenAISpeechStarted`, `_onOpenAIFinalResult`). It also forwards transcripts and function call details to the `webapp`. Audio responses from OpenAI are sent directly to `ari-client.ts`.
8.  `ari-client.ts` handles the OpenAI events to manage call state (e.g., timers for silence detection) and plays back audio responses on the Asterisk channel.
9.  The `webapp` displays the live transcript and any function call interactions.

### Function Calling

This demo allows for function call definitions. The `websocket-server` can be extended to execute custom code for these functions and return their output to the OpenAI model to influence the conversation.

## Full Setup and Configuration

1.  **Configure Asterisk:** See [Asterisk Configuration](#asterisk-configuration) below.
2.  **Set up Environment Variables:** See [Environment Variables](#environment-variables) below.
3.  **Run `websocket-server`:**
    ```shell
    cd websocket-server
    npm install
    npm run dev
    ```
4.  **Run `webapp`:**
    ```shell
    cd webapp
    npm install
    npm run dev
    ```
5.  **Place a Call:** Use a SIP client (softphone) to call the Asterisk extension you configured.

## Environment Variables

Copy `.env.example` to `.env` in both `websocket-server` and `webapp` directories and fill in the required values.

### `websocket-server/.env`

Key environment variables for the `websocket-server` include:

*   `OPENAI_API_KEY`: Your OpenAI API key.
*   `ASTERISK_ARI_URL`: Full URL to your Asterisk ARI interface.
*   `ASTERISK_ARI_USERNAME`: Username for ARI authentication.
*   `ASTERISK_ARI_PASSWORD`: Password for ARI authentication.
*   `ASTERISK_ARI_APP_NAME`: The name of your Stasis application.
*   `WEBSOCKET_SERVER_HOST_IP` (Optional): The IP address the WebSocket server listens on. Defaults to `0.0.0.0` (all interfaces).
*   `RECOGNITION_ACTIVATION_MODE` (Optional): Defines how speech recognition starts (e.g., `VAD`, `IMMEDIATE`, `FIXED_DELAY`). Defaults to `VAD`.
*   `INITIAL_OPENAI_STREAM_IDLE_TIMEOUT_SECONDS` (Optional): Timeout in seconds for the initial OpenAI stream to become responsive (e.g., receive the first transcript or speech start event). Default: 10s.

Many other operational parameters, such as detailed VAD settings, DTMF timeouts, and other timers, are configurable via environment variables which override defaults defined in `websocket-server/config/default.json`. Please refer to `websocket-server/.env.example` for a comprehensive list of available environment variables and `websocket-server/README.md` for detailed explanations of these advanced configurations.

### `webapp/.env`

*   `NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL`: The base URL of the `websocket-server` (e.g., `http://localhost:8081`). The webapp uses this to connect. **IMPORTANT:** If the `webapp` and `websocket-server` run on different machines, or if the `websocket-server` is not accessible via `localhost` from the machine running the `webapp`, you MUST change `localhost` to the actual network IP address (or resolvable hostname) of the `websocket-server` machine (e.g., `NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL="http://192.168.1.100:8081"`).

## Asterisk Configuration

Ensure your Asterisk server is properly configured:

1.  **Enable ARI:**
    *   In `ari.conf` (typically in `/etc/asterisk/`), ensure ARI is enabled and configured.
    *   Set up an ARI user with appropriate permissions. Example:
        ```ini
        [general]
        enabled = yes
        pretty = yes ; Optional: formats JSON responses nicely

        [myariuser]
        type = user
        read_only = no ; Allow control operations
        password = myaripassword
        ```

2.  **Enable Asterisk HTTP Server:**
    *   ARI relies on Asterisk's built-in HTTP server. Ensure it's enabled in `http.conf`.
    *   Example:
        ```ini
        [general]
        enabled = yes
        bindaddr = 0.0.0.0 ; Or a specific IP
        bindport = 8088   ; Default ARI port
        ```

3.  **Dialplan for Stasis Application:**
    *   In your dialplan (e.g., `extensions.conf`), create an extension that routes incoming calls to your ARI application.
    *   Example: If your `ASTERISK_ARI_APP_NAME` is `openai-ari-app` and you want to trigger it by dialing `1234`:
        ```
        exten => 1234,1,NoOp(Call received for OpenAI ARI App)
        same => n,Stasis(openai-ari-app)
        same => n,Hangup()
        ```
    *   Reload your dialplan in Asterisk CLI: `dialplan reload`.

4.  **Audio Codec:**
    *   Ensure that your SIP device/trunk and Asterisk are configured to use **G.711 µ-law (ulaw)** for the call path. The `websocket-server` is configured to expect G.711 µ-law from Asterisk (via its RTP stream) to send to OpenAI, and also expects G.711 µ-law responses from OpenAI for direct playback to the caller. This passthrough strategy minimizes transcoding. Mismatched codecs can result in silence or errors.
    *   Check your SIP peer configuration (e.g., `allow=ulaw` in `sip.conf` or `pjsip.conf`) and ensure it aligns with this.

## Testing

For detailed testing procedures, including audio format verification steps, please refer to the [TESTING.md](websocket-server/TESTING.md) document in the `websocket-server` directory.

# Additional Notes

This repository provides a foundation. Security practices, error handling, and production readiness should be thoroughly reviewed and enhanced before deploying in a live environment.
The `websocket-server` features enhanced logging. Refer to its README for details on log levels.

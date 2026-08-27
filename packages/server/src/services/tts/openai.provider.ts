// ──────────────────────────────────────────────
// OpenAI-compatible TTS Providers
// ──────────────────────────────────────────────
// Covers the OpenAI speech API and everything that speaks it, which is how
// local engines (Chatterbox, Kokoro-FastAPI, AllTalk) are supported without a
// source of their own.
//
// NanoGPT subclasses it: same body shape, different host, different model
// aliases, an extra auth header, and ElevenLabs-branded models that take a
// bracketed emotion cue instead of instructions.

import { BaseTTSProvider } from "./base-tts-provider.js";
import {
  buildElevenLabsTextInput,
  buildSpeechInstructions,
  isNanoGptElevenLabsModel,
  nanoGptHeaders,
  nanoGptV1BaseUrl,
  normalizeNanoGptTtsModelId,
  openAiHeaders,
  openAiModelSupportsSpeechInstructions,
} from "./tts-endpoints.js";
import type { TTSSpeechInput, TTSSpeechRequest } from "./tts-types.js";

export class OpenAITTSProvider extends BaseTTSProvider {
  buildSpeechRequest(input: TTSSpeechInput): TTSSpeechRequest {
    const model = this.resolveModel();
    const instructions = openAiModelSupportsSpeechInstructions(model)
      ? buildSpeechInstructions({ speaker: input.speaker, tone: input.tone })
      : undefined;

    return {
      url: `${this.baseUrl}/audio/speech`,
      headers: openAiHeaders(this.cfg.apiKey),
      body: JSON.stringify({
        model,
        input: input.text,
        voice: input.voice || this.defaultVoice(),
        speed: this.cfg.speed,
        response_format: this.resolveAudioFormat(),
        ...(instructions ? { instructions } : {}),
      }),
      decodeCompressedResponse: false,
    };
  }

  protected defaultVoice(): string {
    return "";
  }
}

export class NanoGptTTSProvider extends OpenAITTSProvider {
  override resolveModel(): string {
    return normalizeNanoGptTtsModelId(this.configuredModel());
  }

  override buildSpeechRequest(input: TTSSpeechInput): TTSSpeechRequest {
    const model = this.resolveModel();
    // NanoGPT's ElevenLabs-branded models take an emotion cue in the text and
    // reject a speed parameter, exactly as ElevenLabs does.
    const elevenLabsModel = isNanoGptElevenLabsModel(model);
    const text =
      this.cfg.source === "elevenlabs" || elevenLabsModel
        ? buildElevenLabsTextInput(input.text, input.tone)
        : input.text;
    const instructions =
      !elevenLabsModel && openAiModelSupportsSpeechInstructions(model)
        ? buildSpeechInstructions({
            speaker: input.speaker,
            tone: input.tone,
            // An ElevenLabs source steers with the bracketed cue, so naming the
            // speaker again in instructions would double it up.
            includeSpeaker: this.cfg.source !== "elevenlabs",
          })
        : undefined;

    return {
      url: `${nanoGptV1BaseUrl(this.baseUrl)}/audio/speech`,
      headers: nanoGptHeaders(this.cfg.apiKey),
      body: JSON.stringify({
        model,
        input: text,
        voice: input.voice || "alloy",
        ...(elevenLabsModel ? {} : { speed: this.cfg.speed }),
        response_format: this.resolveAudioFormat(),
        ...(instructions ? { instructions } : {}),
      }),
      decodeCompressedResponse: false,
    };
  }
}

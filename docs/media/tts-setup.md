# Text to Speech (TTS) Setup

This guide shows you how to set up Text to Speech in Marinara Engine so the app can read messages and game narration out loud. Text to Speech (TTS) turns written chat text into spoken audio. This guide covers picking a voice provider, choosing voices, auto-play, and the per-message playback controls.

## Where TTS settings live

Settings sit in two places, split by what they belong to.

A speech engine is a **connection**, saved in the **Connections** panel beside your model connections. It holds the service, the key, the voice, and everything about how that engine sounds. You can save as many as you like and switch between them, the same way you switch model connections.

Playback belongs to the app, not to any engine, so the **Text to Speech** card in the same panel keeps the master switch, auto-play, and dialogue handling. The card shows which connection currently speaks, with a button to edit it.

Your provider API key is stored encrypted on the server. After you save a key the field shows a row of dots instead of the real key, and the real key is never sent back to your browser.

Turning TTS on does not make anything speak by itself. It reveals the **Speak** button on each message and the **Auto-play** options. You still choose what gets read and when.

## Voice, sound effects, and music are chosen separately

Game Mode can generate three kinds of audio, and each one picks its own connection:

| Purpose | What it covers | Chosen in |
| --- | --- | --- |
| Voice | Spoken chat messages, game narration, combat lines | **Voice** default, or a game's voice pin |
| Sound effects | Short generated effects for scenes | **Sound effects** default, or a game's pin |
| Music | Area and encounter tracks | **Music** default, or a game's pin |

The **Connection defaults** section of the Connections panel has a row for each. Voice is the base: a lane with no default of its own uses the Voice default, then the Voice fallback, then the app-level Text to Speech settings. So if you only ever set the Voice default, everything keeps using it, exactly as before these rows existed.

Set the others when you want different engines for different work, such as a local engine for voice and ElevenLabs for music.

ElevenLabs and NanoGPT generate sound effects and music today, and each connection has to opt in with the **Game sound effects** and **Game music** switches in its editor. A connection that cannot do a job is not offered for it, and its switches are hidden rather than shown greyed out.

NanoGPT works differently from ElevenLabs and needs one extra step. It has no sound-effect or music endpoint of its own: the kind of audio you get is decided by which model you name, so a NanoGPT connection generates nothing for a lane until you set a **model** parameter for it under Engine parameters. Add the **NanoGPT music** or **NanoGPT sound effects** set for a ready-made pair of fields. `ACE-Step-v1.5-Base` is a reasonable starting music model and `mirelo-ai/sfx1.6/text-to-audio` a reasonable sound-effect one, but the list changes without notice, so treat those as examples rather than recommendations.

NanoGPT also takes its time. Rather than answering with audio, it accepts the job and hands back a ticket, and Marinara waits for the result behind the scenes. Nothing extra is needed from you, but a track can take noticeably longer to appear than an ElevenLabs one, and the wait counts against the same timeout.

## Step 1: Create an audio connection

1. Open the **Connections** panel.
2. In the **Text to Speech** card, click **Create**. If you already have an audio connection, the card names it and offers **Edit** instead.
3. Give the connection a name you will recognise later, such as "ElevenLabs" or "Laptop Chatterbox", and save it.

The editor opens on the new connection. If you keep several engines, mark the one you want as the **Voice** default in the **Connection defaults** section of the panel. That is the engine chats and games speak with unless a game pins its own.

## Step 2: Pick the source and enter a key

A **Source** is the service that makes the audio. The five choices are:

- **OpenAI-compatible**: OpenAI, or any server that copies OpenAI's TTS format. This is also the lane for local engines.
- **ElevenLabs**: the ElevenLabs voice service.
- **NanoGPT**: one account that reaches OpenAI, Kokoro, and ElevenLabs voices, billed per character.
- **PocketTTS**: a free voice server you run on your own computer.
- **xAI Voice**: xAI's voice service.

Pick the source, then paste your provider key into **API Key**. To keep an existing key, leave the masked dots in place. To remove a saved key, clear the field.

**You will not see a Base URL field for ElevenLabs, NanoGPT, or xAI Voice.** Those services publish one address, so there is nothing to decide. If you do need to reach one through a proxy or a self-hosted gateway, open **Custom endpoint** underneath the source tiles. A connection whose saved address is not the published one opens with that disclosure already expanded, and offers a reset.

OpenAI-compatible and PocketTTS keep the field visible, because the address is the setting that matters for them.

The **Model** field offers a list for ElevenLabs and NanoGPT, which publish one, and is free text elsewhere. **Test connection** checks that the endpoint answers; **Test voice** actually speaks a sentence through this connection.

The app fills in these defaults per source:

| Source            | Endpoint                             | Default model          | Default voice            |
| ----------------- | ------------------------------------ | ---------------------- | ------------------------ |
| OpenAI-compatible | https://api.openai.com/v1 (editable) | tts-1                  | alloy                    |
| ElevenLabs        | https://api.elevenlabs.io            | eleven_multilingual_v2 | none (you must pick one) |
| NanoGPT           | https://nano-gpt.com/api/v1          | gpt-4o-mini-tts        | alloy                    |
| PocketTTS         | http://localhost:8000 (editable)     | pocket-tts             | alba                     |
| xAI Voice         | https://api.x.ai/v1                  | grok-tts               | eve                      |

For **ElevenLabs**, the **Model** field loads the speech-capable models available through your connection. Model IDs that contain `ttv` are voice-design models, not speech models, and cannot read text out loud. If you choose one by mistake, playback fails with an error that tells you to use a speech model instead.

### NanoGPT reaches several voice services through one key

NanoGPT resells other providers, so one key and one balance cover OpenAI voices, the open-weights Kokoro voices, and ElevenLabs voices. Pick the service through the **Model** field; the app loads the current list from your account once the connection is saved with a key, and falls back to a built-in list before then.

Which model you pick changes what the other fields mean:

| Model                                    | Voices look like                    | Speed        | Emotion steering                                  |
| ---------------------------------------- | ----------------------------------- | ------------ | ------------------------------------------------- |
| `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`   | `alloy`, `nova`, `verse`            | 0.5x to 2.0x | Speaker and tone become spoken-style instructions |
| `Kokoro-82m`                             | `af_bella`, `bm_george`, `jf_alpha` | 0.5x to 2.0x | None; the prefix picks language and gender        |
| `Elevenlabs-Turbo-V2.5`, `Elevenlabs-V3` | a name, such as `Rachel`            | Ignored      | Tone rides in the text as a bracketed cue         |

The voice picker offers the right list for the selected model and still accepts anything typed by hand, which is how you use a MiniMax or Qwen voice ID or a cloned voice.

Marinara talks to NanoGPT's OpenAI-compatible endpoint, which returns audio directly. NanoGPT's native `/tts` endpoint adds voice cloning and ElevenLabs stability controls, but answers with a job to poll and a storage URL to fetch; Marinara does not use it.

### PocketTTS is a separate program

PocketTTS is not built into Marinara Engine. Install [the official PocketTTS server](https://github.com/kyutai-labs/pocket-tts) separately, then start it with `uvx pocket-tts serve`. Marinara does not download or manage it for you.

The official server uses `http://localhost:8000` by default. Leave the **Base URL** on that value unless you changed the host or port. Marinara detects the official multipart `/tts` API automatically. Existing custom URLs for the [OpenAI-compatible PocketTTS wrapper](https://github.com/teddybear082/pocket-tts-openai_streaming_server) remain supported.

## Step 3: Choose a voice

Pick the connection's voice in **Default voice**. It is the voice used whenever nothing more specific applies.

The picker loads the real voice list from the provider once the connection is saved, because it asks the server about this connection rather than about whatever is typed on screen. If you change the key or the address, save before refreshing; the **Refresh** button saves first for you, and a hint says so meanwhile. Before the provider answers, a short built-in list keeps the field usable, and anything typed by hand is always accepted.

For **ElevenLabs**, you must pick a voice. Marinara loads the paginated account library, including personal, workspace, saved, and default voices. The picker has a search box. Playback is blocked until you choose a real one.

## Voice casting: narrator, per character, and NPCs

Open **Voice casting** on the connection. Casting lives here rather than app-wide because a voice ID only means something to the engine that issued it: an ElevenLabs ID is meaningless to a local server. Two saved engines therefore keep separate casts, and switching the default engine switches the whole cast with it.

**One voice for everyone** is the default. Choose **A voice per character** to give chosen characters their own voices: add a row, pick a character on the left and a voice on the right, and repeat. You must create your characters first. Characters without a personal voice fall back to the connection's default voice. See [Creating and Editing Characters](../characters/creating-and-editing-characters.md).

**Narrator voice** covers text no single character speaks, such as scene description or a game master's lines. Turn it on and pick a voice. The app uses it when a line's speaker is Narrator, GM, Game Master, or System, in Roleplay and Conversation messages, and for Game Mode narration with no named speaker.

**Random NPC voices** gives spare voices to minor game characters. It works only in Game Mode, and only for NPCs that Game Mode tracks. Turn it on and tick the voices each pool may draw from. A tracked NPC without a personal voice gets a stable pick from the matching pool and keeps it for the session. If the app cannot detect labeled male or female voices, each pool uses the full voice list.

## Synthesis defaults

Open **Synthesis defaults** on the connection for speed, audio format, and the request budget.

Every control here is optional. Left alone, it follows the app-level setting, which is what an engine nobody has tuned should do. Set one and it belongs to this connection, so a slow local engine and a hosted API stop having to share a timeout. Each control shows **App setting** until you move it, and offers **Follow app setting** to hand it back.

**Speed** stops where the engine does: 0.25 to 4.0 for OpenAI-compatible and PocketTTS, 0.5 to 2.0 for NanoGPT, 0.7 to 1.2 for ElevenLabs, and 0.7 to 1.5 for xAI Voice.

**Audio format** chooses MP3 or WAV. Use WAV for local servers that cannot make MP3. The control is hidden for ElevenLabs and xAI Voice, which always return MP3.

For **ElevenLabs** only, **Language** forces a spoken language or leaves it on auto detect, and **Stability** slides between more expressive and more consistent speech.

The remaining four settings are the request budget. The defaults suit hosted APIs; local engines are the reason these controls exist.

| Setting           | Default        | What it does                                                                                                          |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Request timeout   | 60s            | How long to wait for one chunk before giving up. A local engine on CPU often needs several minutes.                   |
| Chunk size        | 900 characters | How much text goes in one request. Smaller chunks start speaking sooner and suit engines that choke on long passages. |
| Retries           | 1              | Extra attempts after a timeout or a temporary engine failure. A rejected request is never repeated.                   |
| Parallel requests | 1              | How many chunks are synthesized at once. Leave this at 1 unless the engine really does synthesize in parallel.        |

Two things are worth knowing before you raise anything:

- A queued request still spends its timeout while it waits. Raising **Parallel requests** against a single-worker engine makes chunks 2 and 3 sit in its queue burning their own budget, which shows up as timeouts that disappear again at 1.
- WAV is far larger than MP3. A 4096-character WAV chunk can exceed the 20 MB response limit. With WAV, keep **Chunk size** near 2000 or below, or switch to MP3.

Turn on **Progressive playback** as well. Without it the whole message is synthesized before any sound plays, so a five-chunk message on a slow engine is five round trips of silence before the first word. With it, each chunk plays as it arrives and the opening line is split short so speech starts almost immediately.

## Engine parameters

Some engines take settings Marinara has no control for. Chatterbox has `exaggeration` and `cfg_weight`, ElevenLabs keeps `similarity_boost` and `style` inside `voice_settings`, and a self-hosted server can invent whatever it likes. Open **Engine parameters** on the connection to send them.

Marinara does not check what you put here. Anything you set is passed through with the request, and the engine decides whether it understands it. A key it does not recognise usually comes back as a provider error naming the key, which is the fastest way to find the right spelling.

Each purpose is separate, because an engine asked to speak and the same engine asked to score a scene take different settings. **Voice** is always there; **Sound effects** and **Music** appear once the connection has those switches on.

Two views edit the same thing:

- **Fields** shows a control per parameter, with a slider where the engine publishes a range. Parameters Marinara knows about explain themselves; anything else is a text row, so a key you typed is never hidden from you.
- **JSON** is the whole record at once. Nested values are merged rather than replaced, so setting `voice_settings.style` leaves `stability` alone.

**Add known set** fills in the parameters for an engine Marinara has documented, at that engine's own defaults, ready to adjust. Nothing is detected automatically: several different Chatterbox servers exist and an OpenAI-compatible address says nothing about which one is behind it, so choosing the set is your call.

Clearing a row removes the parameter rather than pinning what looks like the default. That matters when the engine later changes its own default: a cleared row follows it, a set one does not.

**Preview the request** shows exactly what would be sent, with the key hidden. It describes the connection as saved, so save first if you have just changed something. This is how you confirm a parameter landed, and landed in the shape the engine wants.

Parameters travel with a connection export. Do not put anything secret in them.

## Rate limiting

**Max requests per minute** on the connection paces everything that uses it: chat speech, game narration, sound effects, music, and the Test voice button all queue against the one cap rather than each getting their own.

Leave it at 0 unless an engine is refusing requests. When one does refuse, Marinara waits exactly as long as the engine asks before trying again rather than guessing, and tells you which connection is being limited.

## Local OpenAI-compatible engines

Any engine that serves the OpenAI `/v1/audio/speech` API works without a dedicated Source. This covers [Chatterbox](https://github.com/resemble-ai/chatterbox), [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), and [AllTalk](https://github.com/erew123/alltalk_tts), among others.

Set **Source** to **OpenAI-compatible**, put the engine's address in **Base URL** including the `/v1` suffix, and set **Model** and **Default voice** to names the engine recognises. The API key can stay empty if the engine does not check one.

```text
Base URL:  http://localhost:8000/v1
Model:     <whatever the engine calls its model>
Voice:     <a voice name the engine knows>
```

Both a **loopback** address such as `http://localhost:8000` and an engine on **another machine on your network** work with no extra server setting. See [Server Configuration Reference](../CONFIGURATION.md) if your server has been hardened with `TTS_LOCAL_URLS_ENABLED=false`.

A reasonable starting point for a CPU engine:

| Setting              | Value |
| -------------------- | ----- |
| Request timeout      | 300s  |
| Chunk size           | 300   |
| Retries              | 1     |
| Parallel requests    | 1     |
| Progressive playback | On    |

If the engine has no voice-list endpoint, the dropdown falls back to the built-in names and the text field beside it accepts any name the engine knows.

## Auto-play: reading messages automatically

Under the **Auto-play** heading, each toggle tells the app to read one kind of new message as soon as it finishes generating. They all need **Enable TTS** to be on first. Every toggle starts off.

- **Roleplay messages**: reads new Roleplay replies.
- **Conversation messages**: reads new Conversation Mode replies.
- **Game narration**: reads new Game Mode narration and combat lines.
- **Progressive playback**: when a reply has several lines, starts playing the first line right away instead of waiting for the whole reply.
- **Only read dialogues**: reads only quoted or tagged spoken lines and skips plain narration.

Auto-play fires only once, on the newest reply, at the moment it finishes. It does not re-read old messages when you reopen or scroll a chat.

## Speaking a single message

Once TTS is on, a **Speak** button (a microphone icon) appears in the toolbar under each character or narrator message. It reads that one message on demand.

- Click **Speak** to read the message. While it is fetching audio, the button shows a loading state.
- Click it again while it plays to stop. The tooltip reads **Stop speaking** while a message is playing.
- A message with no readable text (for example, only an image) shows **No dialogue to speak** and stays disabled.

While a message is speaking, two more buttons appear. **Pause speaking** and **Resume speaking** hold and continue playback. **Restart speaking** starts the message again from the top.

The speaker-icon button opens a **Line volume** slider from 0 to 100 percent, default 50. This volume is its own saved setting. It is separate from the Game Mode mixer and from the Conversation call volume, so changing one does not change the others.

## Cached clips

The app saves generated audio in your browser so it does not need to generate the same line twice. The **Cached clips** panel shows a live count and total size.

Click the **Export cached TTS clips** button (the download icon) to save every cached clip to your device as separate audio files. The trash button beside it empties the cache after a confirmation. Anything you play again after that is generated again.

## TTS in each chat mode

The same TTS setup serves every mode, with a few per-mode extras:

- Roleplay uses the **Roleplay messages** auto-play toggle and the per-message **Speak** controls. See [Roleplay Mode: Getting Started](../roleplay/getting-started.md).
- Conversation Mode uses the **Conversation messages** toggle and the same **Speak** controls. Spoken audio calls are a larger feature covered in [Conversation Audio and Video Calls](../conversation/calls.md).
- Game Mode uses the **Game narration** toggle. Game Mode also has its own audio mixer with a **TTS** channel next to **Master**, **Music**, **Sound Effects**, and **Ambient**. That channel sets the overall volume of spoken game audio and starts at 100 percent. See [Game Mode: Getting Started](../game/getting-started.md).

A game can pin its own connection for each of the three purposes. The setup wizard asks when you create the game, and the **Game Audio** card in the chat settings drawer changes them afterwards, along with whether the game generates sound effects and music at all. A lane you leave unpinned follows the app-level default for that purpose.

## Phonetic name (pronunciation in calls)

If a character or persona name is spelled in a way the voice mispronounces, you can add a **Phonetic name**. In the **Character Editor**, the field sits next to the character's **Name** field. In the **Persona Editor**, it sits with the other basic info fields. Type how the name should sound.

This override is used only during Conversation audio and video calls. The regular per-message **Speak** button, chat auto-play, and Game Mode narration do not read this field.

## Troubleshooting

- Nothing speaks: confirm the **Enable TTS** switch is on. Then check the right per-mode **Auto-play** toggle, or use the per-message **Speak** button. The **Speak** button and auto-play options only appear after TTS is enabled.
- No voices in the dropdown: save the connection with a valid API key, then click **Refresh**. The official PocketTTS server uses Marinara's built-in list because it has no voice-list endpoint. For a compatible PocketTTS wrapper, verify that `<Base URL>/v1/voices` responds.
- ElevenLabs will not speak: make sure you selected a real voice, not the "Select an ElevenLabs voice" placeholder. Also check that the **Model** is a speech model, not a voice-design model whose ID contains `ttv`.
- A self-hosted TTS server on a private or LAN address is blocked: the server has `TTS_LOCAL_URLS_ENABLED=false` set. Remove that line and restart. Loopback addresses such as `localhost` and `127.0.0.1` work either way. See [Server Configuration Reference](../CONFIGURATION.md).
- "The speech engine ran out of time": the engine did not finish a chunk inside the **Request timeout**. Raise it in the connection's **Synthesis defaults**, and lower **Chunk size** so each request is smaller. Local engines on CPU commonly need 300s and chunks near 300 characters.
- Speech starts only after a long pause: turn on **Progressive playback**, which plays each chunk as it arrives instead of synthesizing the whole message first.
- Voice auto-play stopped on its own: auto-play pauses after three failed messages in a row so a stopped engine cannot fill the chat with silent waits. Fix the engine, then press **Speak** on any message to start it again.
- Timeouts appear only when **Parallel requests** is above 1: the engine is synthesizing serially, so queued chunks spend their timeout waiting their turn. Set it back to 1.
- Test your setup fast: **Test voice** on the connection speaks through that engine, and **Test playback** in the Text to Speech card speaks through whichever engine chats will use.

## Related guides

- [Conversation Audio and Video Calls](../conversation/calls.md)
- [Roleplay Mode: Getting Started](../roleplay/getting-started.md)
- [Game Mode: Getting Started](../game/getting-started.md)
- [Supported AI Providers](../connections/providers-reference.md)
- [Creating and Editing Characters](../characters/creating-and-editing-characters.md)
- [Server Configuration Reference](../CONFIGURATION.md)

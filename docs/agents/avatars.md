# 2D and 3D Avatars

Two downloadable agents give your characters and personas an animated avatar that reacts while a reply streams in. **2D Avatars** shows PNGTuber-style sprites or mesh avatars, and **3D Avatars** shows VRM models. Faces follow the reply, and mouths move with the text or with text-to-speech.

This feature is still being built. The sections below fill in as each part lands on `staging`.

Live2D models are not supported. Live2D's licence needs a separate agreement with Live2D even for free open-source apps, and its runtime cannot be shipped with Marinara Engine.

## Downloading the agents

Both agents are still in development and are not in **Download Agents** yet. The steps below apply once they are listed.

**2D Avatars** and **3D Avatars** are separate downloads, so you can install only the one you want. Both work for characters and personas in Roleplay and Game chats.

1. Open **Agents → Download Agents** and install **2D Avatars**, **3D Avatars**, or both. Neither needs a restart.
2. Set up each avatar on the agent's page in **Agents**. See [Setting up an avatar](#setting-up-an-avatar).
3. In a Roleplay or Game chat, open **Chat Settings → Agents → Misc Agents** and add the agent.

The agents send no extra requests to your AI connections while you chat. They need an Engine with Capability API 1.73, and an older Engine refuses to install them.

## Setting up an avatar

How to pick a character or persona on an avatar agent's page in the Agent editor, turn its avatar on, and choose which kind shows. The avatar does not hide the full-body sprite; turn that off yourself if the avatar replaces it.

## 2D avatars: PNGTuber sprites and mesh avatars

How to reuse your expression sprites as a PNGTuber avatar, add blink and talk variants, import a PNGTuber Plus `.save` file, and import a mesh avatar (`.mavatar`).

## 3D avatars: VRM models

How to import a VRM model (`.vrm`, versions 0.x and 1.0) and an optional idle animation (`.vrma`).

## How faces and mouths follow the reply

Avatars react on their own; there is nothing to set up for this part.

**Faces in Roleplay.** While a reply streams in, Marinara Engine reads each finished sentence and guesses its mood. To keep the face from flickering:

- The face changes only when the new mood is clearly stronger than the current one.
- A face stays for at least two seconds.
- The face goes back to calm only after two calm sentences in a row.
- About four seconds after the reply ends, the face relaxes back to calm.

**How the mood is read.** No AI model or chat connection is asked, and your chat text is not sent anywhere else.

- A built-in word list answers at once, everywhere, and knows common mood words in several languages.
- Where your computer can run it, a small emotion model on your computer, the mood reader, reads the sentences instead and understands 36 languages. It downloads once (about 300 MB) when you first open a Roleplay chat with 2D Avatars or 3D Avatars turned on, and never while neither agent is on. Each avatar agent's page in **Agents** shows the download's progress, and a failed download tries again by itself about 10 minutes later. The word list answers until the mood reader is ready, and after the download it works offline. It uses about 1 GB of memory while in use and unloads after 10 idle minutes. Lite installs, Android and computers with less than 3 GB of memory keep the word list.

**Faces in Game mode.** Each line the Game Master shows comes with an expression, and the speaking character's avatar takes it. A character's inner thoughts change the face but not the mouth.

**The Expression Engine.** When it is on in the chat, its pick after the reply is the final face for that reply. A pick that arrives after you sent your next message stays with the reply it was for. Avatars work without it too.

**Mouths.** The mouth moves only for dialogue (words in quotes, `[Name]:` lines and speaker tags), never for narration, at about the pace of speech. If the text appears faster than anyone could say it, the mouth speeds up and then skips ahead so it stays with the words on screen. With streaming off, a reply's dialogue is spoken within eight seconds. When text-to-speech plays a line, the voice moves the mouth instead.

**Body.** An avatar thinks from the moment you send until its first words, talks while its mouth moves, listens while someone else talks or while you type, and rests otherwise.

**Group chats.** In an Individual group, the member who is replying speaks, including when you swipe one member's message. In a Merged group, each paragraph belongs to the first character it names, or to the one before it. While a paragraph that names nobody is still appearing, its dialogue waits until a name or the paragraph's end shows who says it. With streaming off in an Individual group, only the last member's reply moves an avatar for now.

## Lip sync with text-to-speech

When text to speech reads a Roleplay reply, the avatar of the character who is speaking moves its mouth with the voice. The mouth opens wider on loud sounds and closes in pauses. It also changes shape: it rounds on dark sounds like "oo" and shows the teeth on sounds like "s". There is nothing extra to set up. Turn on text to speech as described in [Text to Speech (TTS) Setup](../media/tts-setup.md), and lip sync works with **Auto-play** and with the **Speak** button on a message, including the visual novel layout.

- **Who speaks:** the mouth that moves belongs to the character whose voice reads the line, the same character the **Voice Option** picks a voice for. When a reply has several speakers, each character's mouth moves only during their own lines. Lines read in the narrator's voice, and speakers who are not characters in the chat, move no mouth. With **Only read dialogues** off, a character's own narration is read in their voice, so their mouth moves for it too.
- **Pause, stop and switching chats:** pausing or stopping the voice stops the mouth. If you switch to another chat while a reply is still being read, the avatars there stay still. Come back to the first chat while the voice is still playing, and its avatar picks the voice up again.
- **Volume:** the **Line volume** slider changes how loud the voice is, not how wide the mouth opens.
- **Personas:** a persona's mouth follows the text, not the voice.
- **Game Mode:** Game narration plays through Game Mode's own audio, so in Game Mode avatar mouths follow the text for now.

Lip sync does not change how the voice plays. Marinara Engine reads a separate copy of each voice clip to time the mouth, so playback works as before, including in Safari and on iPhone and iPad. If your browser cannot read a clip, the voice still plays and only the mouth stops following it.

## Making an avatar from a sprite

How to make blink and talk variants or a mesh avatar from one of your sprites in one click.

## Performance and devices

How many avatars show at once on phones and desktops, and when avatars pause to save battery.

## Related guides

- [Agents: AI Helpers for Your Chats](agents-overview.md)
- [Downloadable Agents Reference](built-in-agents.md)

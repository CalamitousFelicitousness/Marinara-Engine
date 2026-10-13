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

How the avatar picks a face while a reply streams in Roleplay and from the Game Master's lines in Game mode, how the Expression Engine sets the final face, and how the mouth follows the text.

## Lip sync with text-to-speech

When text to speech reads a Roleplay reply, the avatar of the character who is speaking moves its mouth with the voice. The mouth opens wider on loud sounds and closes in pauses. It also changes shape: it rounds on dark sounds like "oo" and shows the teeth on sounds like "s". There is nothing extra to set up. Turn on text to speech as described in [Text to Speech (TTS) Setup](../media/tts-setup.md), and lip sync works with **Auto-play** and with the **Speak** button on a message, including the visual novel layout.

- **Who speaks:** the mouth that moves belongs to the character whose voice reads the line, the same character the **Voice Option** picks a voice for. When a reply has several speakers, each character's mouth moves only during their own lines. Lines read in the narrator's voice, and speakers who are not characters in the chat, move no mouth. With **Only read dialogues** off, a character's own narration is read in their voice, so their mouth moves for it too.
- **Pause, stop and switching chats:** pausing or stopping the voice stops the mouth. If you switch to another chat while a reply is still being read, the avatars there stay still. Come back to the first chat while the voice is still playing, and its avatar picks the voice up again.
- **Volume:** the **Line volume** slider changes how loud the voice is, not how wide the mouth opens.
- **Personas:** a persona's mouth follows the text, not the voice.
- **Game Mode:** Game narration plays through Game Mode's own audio, so in Game Mode avatar mouths follow the text for now.

Lip sync does not change how the voice plays. Marinara Engine reads a separate copy of each voice clip to time the mouth, so playback works as before, including in Safari and on iPhone and iPad. If your browser cannot read a clip, the voice still plays and only the mouth stops following it.

## Making an avatar from a sprite

On the **2D Avatars** page in the Agent editor, choose a character or persona, then use **Make an avatar from a sprite**. It works from the sprites the character or persona already has. Your avatar stays the same until you save a result, so you can try as often as you like.

### Blink and talk pictures

1. Pick one or more sprites, then choose **Eyes closed**, **Mouth open** or both.
2. Check the **Image connection** (your default image connection is picked for you) and select **Make pictures**. Every picture is one image request. With **Expose media prompts before sending** on (Settings), you see and can edit each prompt first.
3. The new pictures appear one at a time. Select **Keep** on the ones that look right and **Try again** on the others. **Cancel** stops the picture being made.
4. Select **Save kept pictures**. They become the PNGTuber avatar's blink and talk pictures for those expressions, next to a copy of the sprite they were drawn from so they always line up. If there was no PNGTuber avatar yet, one is made from the kept expressions.

Image models that edit pictures work best, because they get your sprite as a reference. If a picture changes more than the eyes or mouth, the avatar jumps when it blinks or talks; try that one again.

### Mesh avatar

1. Pick one sprite. A front-facing bust (head and shoulders) works best; on a full-body sprite the face is small.
2. Choose the **Chat connection that can see pictures**. **The agent's connection** uses the connection set on the 2D Avatars page, then your default agent connection. Its model must accept pictures.
3. Leave **Draw closed eyes and an open mouth** on to let the image connection draw them. Off, the avatar blinks and talks with built-in eyelids and a built-in mouth. A drawing that doesn't line up with the sprite is left out, and the panel tells you.
4. Select **Make mesh avatar**. The chat model finds the face, and Marinara Engine builds the avatar from your sprite.
5. Check the preview: the outlines should sit on the eyes, brows and mouth. Select **Save as mesh avatar**, or **Discard** and try another sprite or model.

A generated mesh avatar moves its head, eyes, brows and mouth. Its hair moves with the head; hands, single hair strands and hanging accessories are not rigged.

Your sprite is sent to the chat connection, and to the image connection when pictures are drawn. The prompts come from the 2D Avatars agent, where you can edit them like other agent prompts. With debug mode on, every prompt is written to the server log.

## Performance and devices

How many avatars show at once on phones and desktops, and when avatars pause to save battery.

## Related guides

- [Agents: AI Helpers for Your Chats](agents-overview.md)
- [Downloadable Agents Reference](built-in-agents.md)

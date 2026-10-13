# 2D and 3D Avatars

Two downloadable agents give your characters and personas an animated avatar that reacts while a reply streams in. **2D Avatars** shows PNGTuber-style sprites or mesh avatars, and **3D Avatars** shows VRM models. Faces follow the reply, and mouths move with the text or with text-to-speech.

This feature is still being built. The sections below fill in as each part lands on `staging`.

Live2D models are not supported. Live2D's licence needs a separate agreement with Live2D even for free open-source apps, and its runtime cannot be shipped with Marinara Engine.

## Downloading the agents

How to install **2D Avatars** and **3D Avatars** from **Download Agents** and turn them on for a chat.

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
- Where your computer can run it, a small emotion model on your computer reads the sentences instead and understands 36 languages. It downloads once (about 300 MB) the first time an avatar needs it, and the word list answers until it is ready. It uses about 900 MB of memory while in use and unloads after 10 idle minutes. Lite installs and Android keep the word list.

**Faces in Game mode.** Each line the Game Master shows comes with an expression, and the speaking character's avatar takes it.

**The Expression Engine.** When it is on in the chat, its pick after the reply is the final face for that reply. Avatars work without it too.

**Mouths.** The mouth moves only for dialogue (words in quotes, `[Name]:` lines and speaker tags), never for narration, at about the pace of speech. If the text appears faster than anyone could say it, the mouth speeds up and then skips ahead so it stays with the words on screen. With streaming off, a reply's dialogue is spoken within eight seconds. When text-to-speech plays a line, the voice moves the mouth instead.

**Body.** An avatar thinks from the moment you send until its first words, talks while its mouth moves, listens while someone else talks or while you type, and rests otherwise.

**Group chats.** When Marinara Engine knows who is replying, that character speaks. Otherwise each paragraph belongs to the first character it names, or to the one before it.

## Lip sync with text-to-speech

How the mouth follows the voice when text-to-speech plays a line.

## Making an avatar from a sprite

How to make blink and talk variants or a mesh avatar from one of your sprites in one click.

## Performance and devices

How many avatars show at once on phones and desktops, and when avatars pause to save battery.

## Related guides

- [Agents: AI Helpers for Your Chats](agents-overview.md)
- [Downloadable Agents Reference](built-in-agents.md)

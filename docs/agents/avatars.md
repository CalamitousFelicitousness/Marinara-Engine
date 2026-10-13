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

Avatars are set up on each agent's own page. Open **Agents**, open **2D Avatars** or **3D Avatars**, and use the **Avatars** section near the top.

1. In **Character or persona**, choose who gets the avatar. Names marked "(has an avatar)" already have one saved.
2. In **Avatar type**, choose the kind to set up. 2D Avatars offers **PNGTuber sprites** and **Mesh avatar**. 3D Avatars offers **VRM model**.
3. Set it up in that type's own section below the switches: use your sprites or import a file, choose the face for each feeling, or remove it. See [2D avatars](#2d-avatars-pngtuber-sprites-and-mesh-avatars) and [3D avatars](#3d-avatars-vrm-models).
4. Use **Preview** to see it. **Try a face** switches feelings and **Talk** moves the mouth. When there is nothing to show yet, the preview shows an example avatar.

A character or persona with expression sprites already has a PNGTuber avatar on the 2D Avatars page, so chats with 2D Avatars on show it with nothing saved.

**Show this avatar in chats** turns the avatar on or off without deleting it. **Movement** has three switches that apply to every type: **Lip sync** moves the mouth, **Blinking** blinks every few seconds, and **Idle motion** breathes and sways while waiting. If a character has more than one avatar type, **Show this one** picks the type chats use. When that type's agent is off in a chat, the chat shows another type whose agent is on. Removing a type deletes its files; your sprites stay, and an avatar you turned off stays off.

An avatar shows in a Roleplay, Visual Novel or Game chat when the chat has agents on and the matching agent added. It works with or without the Expression Engine. The avatar does not hide the full-body sprite, so turn that off yourself if the avatar replaces it. Avatars stand where the full-body sprite would and share its size. To move them, use the sprites' **Arrange** mode in the Expression Engine's sprite settings.

Imported files are checked before they are stored, and there is no avatar-specific size limit below the server's normal upload limit. Avatar files live in the data folder under `avatar-models/<character or persona>/<id>/`, next to an `avatar.json` with the settings. Backups and profile exports include this folder. Deleting a character or persona deletes its avatar, also when the Danger Zone of Settings clears all **Characters** or **Personas**, and clearing **Media & Assets** there empties the folder. Character card exports never include avatars.

## 2D avatars: PNGTuber sprites and mesh avatars

**2D Avatars** shows one of two kinds of avatar: **PNGTuber sprites**, flat pictures that swap faces, open their mouth and blink, and **mesh avatars**, drawings that move their head, eyes and mouth smoothly. Set both up on the agent's page in the Agent editor after you pick a character or persona.

### PNGTuber sprites

A character or persona with expression sprites already has a PNGTuber avatar: its sprites are the faces, with nothing to set up. Portrait sprites are used when there are any, and full-body sprites otherwise, so one avatar never mixes the two.

- **Talking and blinking pictures.** Add sprites named after a face with `_talk` for the open mouth and `_blink` for closed eyes, for example `happy_talk` and `happy_blink`, and `happy_blink_talk` for both. `_talking`, `_speak`, `_mouth_open`, `_blinking` and `_eyes_closed` work too. A face without them still hops while it talks.
- **Face for each feeling.** Choose which face shows for Neutral, Happy, Angry, Sad, Relaxed and Surprised. **Resting face** uses the Neutral face. When the Expression Engine or the Game Master picks a sprite you have, that exact face shows.
- **Movement.** **Hop while talking** and **Hop height** set the PNGTuber-style bounce. **Time between blinks** is the average; each blink comes a little sooner or later, so it never looks mechanical. With reduced motion turned on in your device, the avatar does not hop or breathe, but its face and mouth still change.
- **Use my sprites** saves the sprites as the avatar's faces. Choosing a face or changing the movement saves it too. **Update from sprites** picks up sprites you added later and keeps the faces you chose for each feeling. After an import, choose **Remove** to go back to your sprites.

**Import PNGTuber Plus save** reads an avatar saved by [PNGTuber Plus](https://github.com/kaiakairos/PNGTuber-Plus) (a `.save` file). Each costume becomes one face, and its talking and blinking layers become the talking and blinking pictures. Costumes are matched to feelings by the names of the pictures they show, such as `angry eyes.png`. Choose a face for any feeling the names did not cover. Some things do not come across:

- Wobble, drag, rotation and stretch are not imported; the avatar shows each layer at rest.
- Animated layers show only their first frame.
- Very old saves keep only the paths of their pictures on the author's computer. Save them again with a newer PNGTuber Plus first.
- A very large avatar is scaled down to 2048 pixels so phones can hold every picture.

Importing a save needs image processing on the server. Some Android installs (Termux) do not have it, so the import is refused there with a message saying so.

### Mesh avatars

A mesh avatar is a `.mavatar` file made with [Mesh Avatar Studio](https://github.com/shinshin86/mesh-avatar-studio). Choose **Import .mavatar file** to add one, or **Replace file** to swap it. With idle motion on, the avatar breathes and looks around on its own. It blinks, and its mouth follows the reply. If the file has drawn mouth shapes, they are used; otherwise simple ones are drawn for it.

Under **Look for each feeling**, choose what each feeling shows: one of the six feelings, or **Smile**, **Shy**, **Half-closed eyes** or **Wink**.

Every file is checked when you import it, and a damaged file is refused with a short reason. So is a file too detailed to play smoothly, or one that unpacks to more than the upload limit. Only the parts the avatar needs are kept, so the original illustration inside the file is not stored. The artwork belongs to its creator; check its licence before you share it.

Mesh avatars need WebGL2, which current browsers have. Without it, or when the browser stops the avatar's graphics to save memory, the avatar shows your PNGTuber setup or your sprites instead.

## 3D avatars: VRM models

How to import a VRM model (`.vrm`, versions 0.x and 1.0) and an optional idle animation (`.vrma`).

## How faces and mouths follow the reply

How the avatar picks a face while a reply streams in Roleplay and from the Game Master's lines in Game mode, how the Expression Engine sets the final face, and how the mouth follows the text.

## Lip sync with text-to-speech

When text to speech reads a Roleplay reply, the avatar of the character who is speaking moves its mouth with the voice. The mouth opens wider on loud sounds and closes in pauses. It also changes shape: it rounds on dark sounds like "oo" and shows the teeth on sounds like "s". There is nothing extra to set up. Turn on text to speech as described in [Text to Speech (TTS) Setup](../media/tts-setup.md), and lip sync works with **Auto-play** and with the **Speak** button on a message, including the visual novel layout.

- **Who speaks:** the mouth that moves belongs to the character whose voice reads the line, the same character the **Voice Option** picks a voice for. When a reply has several speakers, each character's mouth moves only during their own lines. Lines read in the narrator's voice, and speakers who are not characters in the chat, move no mouth. With **Only read dialogues** off, a character's own narration is read in their voice, so their mouth moves for it too.
- **Pause, stop and switching chats:** pausing or stopping the voice stops the mouth. If you switch to another chat while a reply is still being read, the avatars there stay still. Come back to the first chat while the voice is still playing, and its avatar picks the voice up again.
- **Volume:** the **Line volume** slider changes how loud the voice is, not how wide the mouth opens.
- **Personas:** a persona's mouth does not move for your own messages, with or without text to speech.
- **Game Mode:** Game narration plays through Game Mode's own audio, so in Game Mode avatar mouths follow the text for now.

Lip sync does not change how the voice plays. Marinara Engine reads a separate copy of each voice clip to time the mouth, so playback works as before, including in Safari and on iPhone and iPad. If your browser cannot read a clip, the voice still plays and only the mouth stops following it.

## Making an avatar from a sprite

How to make blink and talk variants or a mesh avatar from one of your sprites in one click.

## Performance and devices

Each avatar type's drawing code downloads only the first time an avatar of that type shows, so chats without avatars load nothing extra.

| | Phones | Desktops |
| --- | --- | --- |
| Avatars drawn at once | 2 | 4 |
| Frames per second while talking | 30 | 30 |
| Frames per second while idle | 20, or 15 when the phone is busy | 30 |
| Sharpness (pixel ratio) | up to 1.5× | up to 2× |

A chat shows avatars in the order of its characters, then your persona, up to that limit. Avatars stop drawing completely while the tab is hidden, the window is in the background, the Appearance settings are open, or the chat is off screen or covered by a panel or editor. With **Reduce Ambient Animations & Effects** or your device's reduced-motion setting on, avatars still change faces and move their mouths but skip breathing, swaying and the waiting poses.

## Related guides

- [Agents: AI Helpers for Your Chats](agents-overview.md)
- [Downloadable Agents Reference](built-in-agents.md)

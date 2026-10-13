# 2D and 3D Avatars

Two downloadable agents give your characters and personas an animated avatar that reacts while a reply streams in. **2D Avatars** shows PNGTuber-style sprites or mesh avatars, and **3D Avatars** shows VRM models. Faces follow the reply, and mouths move with the text or with text-to-speech.

This feature is still being built. The sections below fill in as each part lands on `staging`.

Live2D models are not supported. Live2D's licence needs a separate agreement with Live2D even for free open-source apps, and its runtime cannot be shipped with Marinara Engine.

## Downloading the agents

How to install **2D Avatars** and **3D Avatars** from **Download Agents** and turn them on for a chat.

## Setting up an avatar

Avatars are set up on each agent's own page. Open **Agents**, open **2D Avatars** or **3D Avatars**, and use the **Avatars** section near the top.

1. In **Character or persona**, choose who gets the avatar. Names marked "(has an avatar)" already have one.
2. In **Avatar type**, choose the kind to set up. 2D Avatars offers **PNGTuber sprites** and **Mesh avatar**. 3D Avatars offers **VRM model**.
3. Set it up:
   - **Use my sprites** builds a PNGTuber avatar from the character's expression sprites. Full-body sprites are left out. Running it again adds new sprites and keeps the faces you chose.
   - **Import a PNGTuber Plus file**, **Import a mesh avatar** and **Import a VRM model** read a file from your device. **Add an idle animation** attaches a `.vrma` animation to a VRM model.
4. Check **Faces**. Each feeling (and, for models, each mouth shape and the blink) shows the face it uses and where that came from: **Found** when the import or your sprite names matched it, **Your choice** after you change it, and **Missing** when nothing fits. A missing feeling shows the calm face.
5. Use **Preview** to see it. **Try a face** switches feelings and **Talk** moves the mouth. Before anything is set up, the preview shows an example avatar.

**Show this avatar in chats** turns the avatar on or off without deleting it. **Movement** has three switches: **Lip sync** moves the mouth, **Blinking** blinks every few seconds, and **Idle motion** breathes and sways while waiting. If a character has more than one avatar type, **Show this one** picks the type chats use. When that type's agent is off in a chat, the chat shows another type whose agent is on. **Remove** deletes one avatar type and its files; your sprites stay.

An avatar shows in a Roleplay, Visual Novel or Game chat when the chat has agents on and the matching agent added. It works with or without the Expression Engine. The avatar does not hide the full-body sprite, so turn that off yourself if the avatar replaces it. Avatars stand where the full-body sprite would and share its size. To move them, use the sprites' **Arrange** mode in the Expression Engine's sprite settings.

Imported files are checked before they are stored, and there is no avatar-specific size limit below the server's normal upload limit. Avatar files live in the data folder under `avatar-models/<character or persona>/<id>/`, next to an `avatar.json` with the settings. Backups and profile exports include this folder. Deleting a character or persona deletes its avatar, also when the Danger Zone of Settings clears all **Characters** or **Personas**, and clearing **Media & Assets** there empties the folder. Character card exports never include avatars.

## 2D avatars: PNGTuber sprites and mesh avatars

How to reuse your expression sprites as a PNGTuber avatar, add blink and talk variants, import a PNGTuber Plus `.save` file, and import a mesh avatar (`.mavatar`).

## 3D avatars: VRM models

How to import a VRM model (`.vrm`, versions 0.x and 1.0) and an optional idle animation (`.vrma`).

## How faces and mouths follow the reply

How the avatar picks a face while a reply streams in Roleplay and from the Game Master's lines in Game mode, how the Expression Engine sets the final face, and how the mouth follows the text.

## Lip sync with text-to-speech

How the mouth follows the voice when text-to-speech plays a line.

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

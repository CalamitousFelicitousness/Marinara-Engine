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

How the avatar picks a face while a reply streams in Roleplay and from the Game Master's lines in Game mode, how the Expression Engine sets the final face, and how the mouth follows the text.

## Lip sync with text-to-speech

How the mouth follows the voice when text-to-speech plays a line.

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
4. Select **Make mesh avatar**. The chat model finds the face, then Marinara Engine cuts the eyes into their own layers, fills the skin behind them and packs a `.mavatar`.
5. Check the preview: the outlines should sit on the eyes, brows and mouth. Select **Save as mesh avatar**, or **Discard** and try another sprite or model.

A generated mesh avatar moves its head, eyes, brows and mouth. Its hair moves with the head; hands, single hair strands and hanging accessories are not rigged.

Your sprite is sent to the chat connection, and to the image connection when pictures are drawn. The prompts come from the 2D Avatars agent, where you can edit them like other agent prompts. With debug mode on (or `DEBUG_AGENTS=true` on the server), every prompt is written to the server log.

## Performance and devices

How many avatars show at once on phones and desktops, and when avatars pause to save battery.

## Related guides

- [Agents: AI Helpers for Your Chats](agents-overview.md)
- [Downloadable Agents Reference](built-in-agents.md)

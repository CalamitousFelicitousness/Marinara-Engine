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

**3D Avatars** shows VRM models, the format that VRoid Studio, the VRM add-on for Blender and UniVRM for Unity export. VRM 1.0 and VRM 0.x files both work.

1. Open **3D Avatars** in the Agent editor and pick the character or persona.
2. Under **VRM model**, select **Import VRM** and choose a `.vrm` file.
3. Read **The author's terms**. They come from the model file and say who may use the model as an avatar, whether commercial use is allowed, and whether you may change the model. Marinara Engine shows them but does not enforce them, so please follow them yourself.
4. Under **Faces and mouth shapes**, check which of the model's expressions shows each face (Neutral, Happy, Angry, Sad, Relaxed and Surprised), each mouth shape (A, I, U, E and O) and blinking. Most are filled in for you: **Set by the model** means the model has the standard VRM expression, and **Guessed from its name** means one of its own expressions has a matching name. Pick another expression, or **None**, whenever a guess looks wrong.
5. Optionally, under **Idle animation**, add a `.vrma` file for the model to play while it waits. Without one, the model breathes and sways gently.

**Replace model** keeps the idle animation, because VRM animations fit any VRM model. **Remove model** deletes the model and its idle animation.

While a chat runs, the model looks at you, blinks on its own when it has a blink expression, and tilts its head while it thinks or listens. A tall avatar spot shows the whole body; a square or wide one shows the head and shoulders. With reduced motion on, the face and mouth still change, but the model stops swaying, breathing and playing its idle animation.

Some files can't be used, and the import says why:

- **Compressed models.** Files saved with Draco or meshopt compression, or with KTX2 textures, don't load. Export the model again with compression turned off.
- **Plain 3D models.** A `.glb` or `.gltf` model without VRM data has no face expressions or humanoid skeleton. Convert it to VRM first, for example with the VRM add-on for Blender.
- **Incomplete models.** A model whose skeleton is missing bones VRM needs, or that points to files outside itself, is refused.

There is no size limit beyond the app's usual upload limit, but large models take longer to load, especially on phones.

## How faces and mouths follow the reply

How the avatar picks a face while a reply streams in Roleplay and from the Game Master's lines in Game mode, how the Expression Engine sets the final face, and how the mouth follows the text.

## Lip sync with text-to-speech

How the mouth follows the voice when text-to-speech plays a line.

## Making an avatar from a sprite

How to make blink and talk variants or a mesh avatar from one of your sprites in one click.

## Performance and devices

How many avatars show at once on phones and desktops, and when avatars pause to save battery.

## Related guides

- [Agents: AI Helpers for Your Chats](agents-overview.md)
- [Downloadable Agents Reference](built-in-agents.md)

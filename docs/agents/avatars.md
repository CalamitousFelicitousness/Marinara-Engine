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

**3D Avatars** shows VRM models, the format that VRoid Studio, the VRM add-on for Blender and UniVRM for Unity export. VRM 1.0 and VRM 0.x files both work.

1. Open **3D Avatars** in the Agent editor and pick the character or persona.
2. Under **VRM model**, select **Import VRM** and choose a `.vrm` file.
3. Read **The author's terms**. They come from the model file and say who may use the model as an avatar, whether commercial use is allowed, whether you may change the model, whether sexual or very violent content is allowed, and for VRM 1.0 models whether you must credit the author and may share the file. When the file links to a license or to the author's own terms, open them too. Marinara Engine shows the terms but does not enforce them, so please follow them yourself.
4. Under **Faces and mouth shapes**, check which of the model's expressions shows each face (Neutral, Happy, Angry, Sad, Relaxed and Surprised), each mouth shape (A, I, U, E and O) and blinking. Most are filled in for you: **Set by the model** means the model has the standard VRM expression, and **Guessed from its name** means one of its own expressions has a matching name. Pick another expression, or **None**, whenever a guess looks wrong.
5. Optionally, under **Idle animation**, add a `.vrma` file for the model to play while it waits. Without one, the model breathes and sways gently.

**Replace model** keeps the idle animation, because VRM animations fit any VRM model. **Remove model** deletes the model and its idle animation.

While a chat runs, the model looks at you, blinks on its own when it has a blink expression, and tilts its head while it thinks or listens. Its head stays near the top of its spot: a wide spot shows the head and shoulders, and a narrower one shows more of the body. Some VRM 1.0 models keep the mouth still while they show a face; while such a model talks, that face shows at partial strength so the mouth can still move. With reduced motion on, the face and mouth still change, but the model stops swaying, breathing and playing its idle animation.

Some files can't be used, and the import says why:

- **Compressed models.** Files saved with Draco or meshopt compression, or with KTX2 textures, don't load. Export the model again with compression turned off.
- **Plain 3D models.** A `.glb` or `.gltf` model without VRM data has no face expressions or humanoid skeleton. Convert it to VRM first, for example with the VRM add-on for Blender.
- **Incomplete models.** A model whose skeleton is missing bones VRM needs or points to parts that aren't in the file, or that points to files outside itself, is refused.

There is no size limit beyond the app's usual upload limit, but large models take longer to load, especially on phones.

## How faces and mouths follow the reply

Avatars react on their own; there is nothing to set up for this part.

**Faces in Roleplay.** While a reply streams in, Marinara Engine reads each finished sentence and guesses its mood. To keep the face from flickering:

- The face changes only when the new mood is clearly stronger than the current one.
- A face stays for at least two seconds.
- The face goes back to calm only after two calm sentences in a row.
- About four seconds after the reply ends, the face relaxes back to calm.

**How the mood is read.** Your chat connection is not asked. Your chat text stays with your own Marinara Engine and is never sent to an outside service.

- A built-in word list answers at once, everywhere, and knows common mood words in several languages.
- Where the computer running Marinara Engine can run it, a small emotion model there, the mood reader, reads the sentences instead and understands 36 languages. It downloads once, about 300 MB, the first time you open a Roleplay chat with 2D Avatars or 3D Avatars turned on. It does not download while both agents are off. Each avatar agent's page in **Agents** shows the download's progress, and a failed download tries again by itself about 10 minutes later. The word list answers until the mood reader is ready, and after the download it works offline. It uses about 1 GB of memory while in use and unloads after 10 idle minutes. Lite installs, Android and computers with less than 3 GB of memory keep the word list.

**Faces in Game mode.** Each line the Game Master shows comes with an expression, and the speaking character's avatar takes it. A character's inner thoughts change the face but not the mouth.

**The Expression Engine.** When it is on in the chat, its pick after the reply is the final face for that reply. A pick that arrives after you sent your next message stays with the reply it was for. Avatars work without it too.

**Mouths.** From the text, the mouth moves only for dialogue (words in quotes, `[Name]:` lines and speaker tags), not for narration, at about the pace of speech. If the text appears faster than anyone could say it, the mouth speeds up and then skips ahead so it stays with the words on screen. With streaming off, a reply's dialogue is spoken within eight seconds. When text-to-speech plays a line, the voice moves the mouth instead, so a character's narration read in their voice moves their mouth too.

**Body.** An avatar thinks from the moment you send until its first words, talks while its mouth moves, listens while someone else talks or while you type, and rests otherwise.

**Group chats.** In an Individual group, the member who is replying speaks, including when you swipe one member's message. In a Merged group, each paragraph belongs to the first character it names, or to the one before it. While a paragraph that names nobody is still appearing, its dialogue waits until a name or the paragraph's end shows who says it. With streaming off in an Individual group, only the last member's reply moves an avatar for now.

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

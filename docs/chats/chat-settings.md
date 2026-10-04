# Chat Settings Overview

This guide covers the **Chat Settings** window, the place where you tune one chat on its own. It explains the basics you set here: chat name, connection, and saved setting bundles. It then points you to the deeper guides for everything else the panel holds.

Every setting in this panel applies to the current chat only. Changing it does not affect your other chats.

## Opening Chat Settings

You open Chat Settings from inside an open chat.

1. Open any chat.
2. On a computer, click the **Chat Settings** button in the middle of the top bar. It only appears while a chat is open. On a phone, tap **More options** (the three dots) at the top of the chat, or **Game actions** in a Game, then tap **Chat Settings**.
3. The **Chat Settings** window opens.

When you create a brand new chat, Chat Settings opens automatically so you can set it up right away.

## Moving, pinning and locking the window

On a computer, Chat Settings is a window that floats over the chat. Its contents rearrange to fit its size.

- **Move it** by dragging its title bar. With the title bar focused, the arrow keys move it too; hold Shift for bigger steps.
- **Resize it** by dragging any edge or corner. The bottom-right corner can also be focused and resized with the arrow keys.
- **Pin** (the pin button) keeps the window open when you click elsewhere. Unpinned, it closes when you click outside it, or when you press Escape anywhere except a text box.
- **Lock** (the padlock button) stops the window from moving or resizing until you unlock it.
- **Close** (the X button) closes the window.

The window stays inside the chat area, even when you resize the browser or open a sidebar. Marinara remembers its size, place, pin and lock on this device.

Two controls sit at the top of the window:

- **Tracker Panel** shows or hides the Tracker Panel beside a Roleplay chat. It appears in Roleplay chats when the Tracker Panel is turned on in **Settings → Appearance** and the chat uses agents or Advanced Memory.
- **Reset View** puts the window back where it started, unpinned and unlocked.

The **?** button beside the **Chat Settings** title opens the chat's Help layout, which labels each part of the chat. On a phone, Help stays in **More options**, or **Game actions** in a Game. You can hide it with **Hide chat Help button** in **Settings → General → App Behavior**.

On a phone, Chat Settings opens as a full-width panel instead of a window.

## Chat Name

The **Chat Name** section holds the name shown in your chat list. This name is only visible to you. It is not sent to the AI and does not change the conversation in any way.

1. In the **Chat Name** section, click the current name.
2. The name turns into a text box.
3. Type a new name.
4. Press Enter, or click the checkmark button to confirm.

## Connection

The **Connection** section picks which AI provider and model answers in this chat. A connection is a saved link to an AI provider, including its API key and chosen model. An API key is a secret code that lets Marinara Engine use your account with that provider.

Pick a saved connection from the dropdown. You can also pick **Random**. It chooses a different connection each time from the connections you marked for your random pool.

To learn how to create a connection in the first place, see [Connecting to an AI Provider](../connections/connecting-to-a-provider.md).

## Settings Profiles

At the top of the panel is the **Profile** control. A settings profile is a saved bundle of chat settings that you can reuse on other chats. Choose a profile from the dropdown to apply it to the current chat.

A profile bundles this chat's connection, prompt preset, agents, tools, translation, memory recall, advanced parameters, and other settings. It never changes your characters, persona, lorebooks, sprites, summary, tags, or scene prompt. Those stay tied to the chat itself.

The bar has a row of small icon buttons with no text labels. Each button shows its name in a tooltip when you hover over it:

- The disk icon (**Save current chat settings into this profile**) writes the current chat's settings into the selected profile.
- The pencil icon (**Rename profile**) renames the selected profile.
- The file-plus icon (**Save current chat settings as a new profile**) saves the current chat's settings as a new profile.
- The down-arrow icon (**Import settings profile (.json)**) loads a profile from a `.json` file.
- The up-arrow icon (**Export settings profile (.json)**) saves the selected profile to a `.json` file.
- The trash icon (**Delete profile**) removes the selected profile.

Next to the dropdown is a star button. Click it to make a profile the default for new chats in this mode. When you create a new chat in that mode, Marinara applies the starred profile for you. Only one profile per mode can be the default.

Each mode that supports this feature has a built-in **Default** profile. You cannot rename, save into, or delete the **Default** profile. Applying it resets the profile-controlled settings to the app defaults.

The profile controls do not appear in Game mode.

Marinara reserves **preset** for prompt presets. A prompt preset shapes the system prompt structure and generation parameters; a settings profile bundles the reusable chat configuration listed above. For the full rules, see [Settings Profiles](settings-profiles.md).

## Chat Variables

The **Chat Variables** section lets you give a name to a piece of text and reuse it by typing that name in double braces. Add a variable called `char1` with the value `Mary`, then write `{{char1}} walks in.` in a message. The AI reads "Mary walks in."

Each row has a **name** and a **value**. Names use letters, numbers, and underscores, and must start with a letter or underscore. Names with exactly 21 characters are reserved for character references. A name that belongs to a built-in macro, such as `char` or `user`, is refused, because the built-in one always wins. Press Enter or click outside a field to save it. The trash button removes a variable.

Three things are worth knowing.

- Your message keeps showing the tag you typed. Only the AI sees the value. That also means changing a value later changes every earlier turn that used the tag.
- Variables belong to this chat alone. Another chat has its own list, and yours survives a restart.
- This is the same storage `{{setvar}}` uses. A value set by a prompt section or a lorebook entry shows up here as a row you can edit, and such an entry overwrites the value you typed if it uses the same name.

For everything else you can write in double braces, see [Prompt Macros](../prompts/macros.md).

## Other sections in the panel

The **Chat Settings** panel is also the home for many per-chat features. Each has its own guide:

- **Persona** picks who you play in this chat. It appears in Conversation and Roleplay chats. See [Choosing Your Persona in a Chat](../characters/choosing-your-persona.md).
- **Characters** manages the characters in Conversation and Roleplay chats. For chats with two or more characters, see [Group Chats and Group Conversations](group-chats.md).
- **Party** appears only in Game chats. It replaces the **Persona** and **Characters** sections and combines both in one place.
- **Lorebooks** attaches world info to this chat. See [Lorebooks Overview](../lorebooks/overview.md).
- **Agents** turns on AI helpers for this chat. See [Agents: AI Helpers for Your Chats](../agents/agents-overview.md).
- **Translation** sets up automatic message translation. See [Message Translation](../integrations/message-translation.md).
- **Advanced Parameters** overrides the generation settings, such as temperature and max tokens, for this chat. See [Generation Parameters](../prompts/generation-parameters.md).

Which sections you see depends on the chat mode. Some sections appear only in Roleplay, Conversation, or Game chats.

## Related guides

- [Managing Your Chat List](managing-chats.md)
- [Choosing Your Persona in a Chat](../characters/choosing-your-persona.md)
- [Lorebooks Overview](../lorebooks/overview.md)
- [Agents: AI Helpers for Your Chats](../agents/agents-overview.md)
- [Settings Profiles](settings-profiles.md)
- [Generation Parameters](../prompts/generation-parameters.md)

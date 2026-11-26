# Talkie design principles

This page is how Talkie's web and Android apps apply the classic interface rules. Check new screens and features against it.

## Shneiderman's eight golden rules

| Rule | How Talkie applies it |
|---|---|
| **1. Strive for consistency** | **One set of design tokens** (`apps/web/app/globals.css`, `apps/mobile/lib/ui/theme.dart`). Components use names like `surface` and `brand`, never raw colours.<br>**Fonts:** Quicksand (English) and Baloo Da 2 (Bangla).<br>**Same patterns everywhere:** gold fills carry dark text, and your own bubbles carry their own ink colour. Every text field has the same thin focus style, and every icon sits on the same grid. |
| **2. Seek universal usability** | **Bangla and English**, with **light, dark and system** themes (Settings → *Language & theme*).<br>**Every screen fits** from 320 px phones to desktops. Touch targets are at least 40–44 px.<br>**Screen readers:** labels, `aria-live` toasts, and `role="alert"` for errors.<br>**For frequent users:** keyboard shortcuts (`Ctrl/⌘ + K` search, `Esc`, `Enter` and `Shift + Enter`, meeting `Ctrl/⌘ + D` and `E`), with `?` to list them. |
| **3. Offer informative feedback** | **Message state:** a clock while a message sends, then sent, delivered and read ticks.<br>**Live activity:** typing and online indicators, plus upload progress.<br>**Connection:** a status badge when the live connection drops.<br>**Results:** toasts for results and errors in plain words. Skeletons show while lists load. |
| **4. Design dialogs to yield closure** | **Clear ends:** sign-in is three steps with a progress bar and a clear end ("signed in"). Reports, deletes and settings end with a short confirmation.<br>**Calls:** every call ends with its outcome (missed, declined, duration). |
| **5. Prevent errors** | **Unavailable actions are disabled:** for example, an empty message can't be sent, and "Delete for everyone" only appears within its time limit.<br>**Validation:** fields are checked as you type (username, email, code).<br>**Destructive actions:** deleting a message and leaving a group ask first.<br>**Shown in context:** your own role and limits are shown where they apply. |
| **6. Permit easy reversal of actions** | **Undo:** *Delete for me* and *Archive chat* show **Undo** for about 5 seconds. Delete-for-me is only sent to the server after that window.<br>**Reversible:** edit a message (15 min), unarchive, unmute, unpin and unblock.<br>**Admin:** restore restores a suspended account. |
| **7. Keep users in control** | **Nothing happens without a tap:** notifications are asked for with a button, never on page load. Calls never start by themselves, and media is never posted without a send.<br>**Your choices are kept:** theme and language.<br>**You decide visibility:** privacy settings control who sees last seen, photo and status. |
| **8. Reduce short-term memory load** | **Recognition over recall:** names, avatars, previews and reply quotes, plus search.<br>**Each chat keeps its unsent draft** when you switch chats (memory only, never on disk).<br>**Context stays visible:** the date dividers and "unread" stay visible, and the shortcut list is one key away. |

## Other principles we follow

- **Norman's principles:**
  - **Visible affordances:** buttons look pressable, and fields look editable.
  - **Natural mapping:** a swipe on a bubble replies to that bubble.
  - **Constraints:** see rule 5.
  - **Feedback:** see rule 3.
- **Nielsen's heuristics:**
  - The app's state is always visible (ticks, connection, call phase).
  - The app speaks the user's language, with no internal ids or jargon in messages.
  - Error messages say what happened and what to do.
- **Jakob's law:** chats, status and calls work like the messengers people already use, so there's nothing new to learn.
- **Fitts's law:**
  - Primary actions (send, call, accept) are large and placed where thumbs reach.
  - Destructive actions are kept apart from them.
- **Hick's law:** menus show only actions that apply right now, and rare options live in Settings.
- **Doherty threshold (under 400 ms):** optimistic UI.
  - A sent message, reaction or setting change shows immediately and is confirmed in the background.
- **Gestalt:**
  - Consecutive messages from one person are grouped.
  - Related settings sit in one card.
  - Spacing follows a 4 px grid.
- **Accessible contrast (WCAG AA):**
  - Text on gold fills is dark brown (`--on-brand`, over 8:1).
  - Gold text on white uses deep gold `#B45309` (about 5:1).
  - Dark mode has its own checked shades.
- **Calm, professional details:**
  - Focus rings are thin and soft on text fields.
  - Keyboard focus on buttons stays clearly visible.
  - No subtitles, hint lines or guide text: labels speak for themselves.
  - No synthetic italics for Bangla.

## Checklist for a new screen

1. **Colours:** use tokens only, and check contrast in both themes.
2. **Responsive:** works at 320, 375, 768 and 1280 px, with no sideways page scroll.
3. **Errors:** every action has feedback, and every error has a plain-language message.
4. **Destructive actions:** they have a confirmation or an Undo.
5. **Keyboard:** works with the keyboard alone, and has screen-reader labels.
6. **Language:** works in Bangla and English, with no hard-coded words in the code.

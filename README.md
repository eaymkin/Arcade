# Arcade

Arcade is a standalone Windows desktop app that combines a game launcher with
the existing game browser. It uses its own bundled Chromium runtime and does
not require Chrome or Edge to be installed or opened. The app includes a
custom dark title bar and loads DuckDuckGo search results inside the current
Arcade tab. Search results use the full tab area, and opening a website from
an embedded page creates a new Arcade tab.
Sign-in redirects and authentication popups for OpenAI, Google, Microsoft,
Apple, GitHub, and Facebook are kept in the active sign-in flow so OAuth
callbacks can return to the page that started them.
Google sign-in opens a temporary page at `http://localhost:5000` in the system
browser. Google Identity Services provides the sign-in token, which Arcade
validates with Firebase Authentication. Arcade never asks for Google
passwords, authorization codes, or OAuth client secrets. When Firebase is
connected, Firebase Auth keeps the app session on this device and Firestore
stores friend requests, friend links, and chat messages.

## Game library

Open **Библиотека** or use the plus button on the left to add an already
installed Windows game. Select its `.exe` file, optionally enter launch
arguments and a category, then press **Играть** to start it. The library,
launch history, and playtime are stored locally in Arcade's user data folder.
Removing a game only removes its Arcade library entry; it does not delete game
files. Arcade does not download paid games or bypass DRM.

Use **Настройки** to change the theme/accent color, enable minimizing to the
Windows system tray, or turn on Windows startup. Tray actions let you reopen
Arcade or exit it. Per-game and total playtime are tracked while Arcade is
running. Arcade also blocks requests to a built-in list of common advertising
and tracking domains by default. Turn this off in **Настройки** if a site
doesn't work correctly; first-party ads may still appear.

The **Магазин** page has a small free-to-play catalog for Steam and Epic Games
Store. Selecting a game opens its official store page in a new Arcade tab.
The official Steam or Epic client handles installation and game downloads;
Arcade does not download game files itself.

## Enable the online friends chat

1. Open the [Firebase console](https://console.firebase.google.com/) and add
   Firebase to the Google Cloud project `stable-arch-512810-p8`.
2. In Firebase **Project settings → General**, add a Web app and copy its
   `apiKey`, `authDomain`, `projectId`, and `appId` into `firebase-config.js`.
   These web-app values are public configuration, not a service-account key.
   Do not put a service-account JSON file or private key in Arcade.
3. In Firebase **Authentication → Sign-in method**, enable **Google**.
4. In Firebase **Authentication → Settings → Authorized domains**, ensure the
   local sign-in domain `localhost` is listed. If it is missing, add it. The
   Google provider uses Firebase's configured OAuth client; Arcade users do
   not enter a client secret.
   In **Authentication → Sign-in method → Google**, make sure the provider is
   enabled and its Web OAuth client belongs to this Firebase project. Do not
   configure a desktop OAuth client in place of the Web client, and never put
   an OAuth client secret in Arcade.
   In Google Cloud **Google Auth Platform → Clients**, the Web OAuth client
   must allow `http://localhost:5000` under **Authorized JavaScript origins**
   and `https://<project-id>.firebaseapp.com/__/auth/handler` under
   **Authorized redirect URIs**. Port 5000 must be free while signing in.
5. Create a **Cloud Firestore** database. Publish the rules from this folder
   with `npx firebase-tools deploy --only firestore:rules
   --project stable-arch-512810-p8`, or paste `firestore.rules` in the
   Firebase Console's Firestore **Rules** tab and publish there.
6. Keep your Google account in the OAuth consent screen's **Test users** list
   while the app is in testing mode.
7. Rebuild and run Arcade:

   ```powershell
   npm.cmd install
   npm.cmd start
   ```

Sign in with Google, choose an Arcade nickname, then use the plus button on the
left to find a friend by nickname. The friend must also install Arcade, enable
Firebase for the same project, and sign in. Accepting a friend request opens a
private, real-time conversation. Firestore rules limit messages to the two
accepted friends; messages are limited to 2,000 characters. Use **Звонок** in
the conversation header to start a peer-to-peer audio call, or accept an
incoming call in the call prompt. Calls require microphone permission. Arcade
allows microphone access only for its own call screen; it does not grant camera
access or microphone access to embedded websites.

After adding or changing the audio-call feature, publish the current
`firestore.rules` file using the deployment command above or from the Firebase
Console's Firestore **Rules** tab.
The rules restrict call signaling and ICE candidates to the two members of
that accepted friendship. Arcade currently uses Google's public STUN server;
some routers or restrictive networks may require a TURN relay service for
audio calls to connect reliably.

## Run from source

Install Node.js, then run these commands in this folder:

```powershell
npm.cmd install
npm.cmd start
```

## Build the Windows installer

```powershell
npm.cmd run dist
```

The installer is created in the `dist` folder. Websites that block embedding
can be opened in a separate Arcade window from the link shown on the page.

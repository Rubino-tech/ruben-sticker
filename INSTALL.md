# 🌟 Ruben Sticker Map

## ☁️ Enable cloud sync (so everyone sees each other's pins)

By default pins are saved locally in your browser only. Follow these steps to make pins visible to **all** users:

### Step 1 — Create a free Firebase project
1. Go to **https://console.firebase.google.com** and sign in with a Google account
2. Click **"Add project"** → name it anything (e.g. `ruben-sticker-map`) → click through the wizard
3. On the project overview page click the **`</>`** (Web) icon → register the app → copy the **firebaseConfig** values

### Step 2 — Enable Firestore Database
1. In the left sidebar click **Build → Firestore Database**
2. Click **"Create database"** → start in **production mode** → choose a region → Done
3. Go to the **Rules** tab and replace the rules with:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /pins/{doc} {
      allow read, write: if request.auth != null;
    }
  }
}
```
4. Click **Publish**

### Step 3 — Enable Firebase Storage (for photos)
1. In the left sidebar click **Build → Storage**
2. Click **"Get started"** → production mode → Done
3. Go to the **Rules** tab and replace the rules with:
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```
4. Click **Publish**

### Step 4 — Enable Anonymous Auth
1. In the left sidebar click **Build → Authentication**
2. Click **"Get started"** → **Sign-in method** tab → **Anonymous** → enable → Save

### Step 5 — Paste your config into the app
Open **index.html** in a text editor, find the `FIREBASE_CONFIG` block near the top of the `<script>` section, and fill in the values from Step 1:
```js
const FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```
Save the file, redeploy to GitHub Pages, and all users will now share the same map! 🎉

---

## 📱 Install as a real app on your phone (recommended)

### Step 1 — Host for free on GitHub Pages (takes 3 minutes)
1. Go to **github.com** and create a free account (or log in)
2. Click **+** → **New repository** → name it `ruben-sticker-map`
3. Make it **Public**, click **Create repository**
4. Click **uploading an existing file** and drag ALL files from this folder
5. Click **Commit changes**
6. Go to **Settings** → **Pages** → Source: **Deploy from branch** → branch: **main** → Save
7. After ~1 minute your app is live at: `https://YOUR-USERNAME.github.io/ruben-sticker-map/`

### Step 2 — Install on phone
**Android (Chrome):**
- Open the link above in Chrome
- Tap the 3-dot menu → **"Add to Home screen"**
- Done! The app icon appears on your home screen.

**iPhone (Safari):**
- Open the link above in Safari
- Tap the Share button (square with arrow) → **"Add to Home Screen"**
- Done!

---

## 💻 Run locally on your computer
Just double-click **start.bat** (Windows) or run `python3 start.py` (Mac/Linux).
The app opens automatically at http://localhost:5173

---

## 🔄 Updating
To update the app, just re-upload the files to GitHub and wait ~1 minute.

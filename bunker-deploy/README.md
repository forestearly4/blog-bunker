# Blog Bunker — Cask & Stream

> Cast at Dawn. Sip at Dusk.

A private blogging dashboard for Cask & Stream, built on React + Vite, deployed on Netlify.

---

## Deploy in 5 steps

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
gh repo create blog-bunker --private --push
```

### 2. Connect to Netlify
- Go to [app.netlify.com](https://app.netlify.com) → Add new site → Import from Git
- Select your `blog-bunker` repo
- Build command: `npm run build` (auto-detected)
- Publish directory: `dist` (auto-detected)
- Click **Deploy**

### 3. Enable Netlify Identity
- Netlify dashboard → **Identity** tab → **Enable Identity**
- Registration: **Open** (or Invite Only if you want to keep it private)
- Under **Emails**, enable **Confirmation emails** so new users verify their address

### 4. Add your Anthropic API key
- Netlify dashboard → **Site configuration** → **Environment variables**
- Add: `ANTHROPIC_API_KEY` = your key from [console.anthropic.com](https://console.anthropic.com)
- Redeploy after adding (Deploys → Trigger deploy)

### 5. Visit your site & sign up
- Open your Netlify URL
- Click **Create one free** → sign up with your email
- Check your email, confirm your account
- Sign in → complete the 5-step onboarding → you're in

---

## Local development

```bash
npm install
npm run dev
```

For local AI features, create a `.env` file:
```
ANTHROPIC_API_KEY=sk-ant-...
```

Then run Netlify CLI instead of Vite directly so the function proxy works:
```bash
npm install -g netlify-cli
netlify dev
```

---

## File structure

```
blog-bunker/
├── index.html                        ← Netlify Identity script tag
├── vite.config.js
├── package.json
├── netlify.toml                      ← build + proxy redirect
├── netlify/
│   └── functions/
│       └── claude-proxy.js          ← keeps API key server-side
└── src/
    ├── main.jsx                      ← ReactDOM entry
    ├── App.jsx                       ← auth → onboarding → dashboard
    ├── auth.jsx                      ← Netlify Identity (sign in/up/reset)
    ├── onboarding.jsx                ← 5-step first-run flow
    └── dashboard.jsx                 ← main app
```

---

## Upgrading plans
Billing UI is wired up visually. To accept real payments, connect Stripe:
1. Create products in Stripe dashboard (Scout/Operative/Command)
2. Add a `netlify/functions/create-checkout.js` function
3. Wire the Upgrade buttons to it

---

## Notes
- Auth: email + password only, no usernames (Netlify Identity / GoTrue)
- AI calls route through `/api/claude` → `netlify/functions/claude-proxy.js` so your API key never hits the browser
- Workspace data persists in `localStorage` keyed to user ID — good for v1, upgrade to a DB for multi-device sync
- Scout plan (free) gates AI Tools and Advanced Analytics behind an upgrade prompt

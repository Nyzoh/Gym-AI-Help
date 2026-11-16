# Gym AI Coach

A minimal web app where an AI coach turns your profile into a weekly training program and nutrition advice.
Plain Node.js (22+) with **zero npm dependencies**, a vanilla JS frontend and Google Gemini as the AI.

## Features

- **AI-generated plan**: a day-by-day program (exercises, sets, reps, rest) plus calorie/protein targets and nutrition tips, tailored to weight, height, age, sex, goal, training days, equipment, typical diet and injuries.
- **Chat coach**: ask follow-up questions about your plan in a chat panel. If you ask for a change ("replace squats with something knee-friendly", "change the calorie intake to 3000+"), the coach returns a complete updated plan. It is shown right away with a visible "Plan updated by coach" note and an **Undo** button that restores the previous plan.
- **Compact layout**: on desktop the profile form, the plan and the chat sit side by side, and the plan scrolls in its own container. Nutrition and safety notes come first; each day is a collapsed card that expands on click ("Expand all / Collapse all").
- **Saved in this browser**: the profile, the latest plan and the chat are kept in `localStorage` and restored on reload, with a "Clear" button to remove them. The access code is never stored.
- **Secrets stay on the server**: the Gemini API key and the access code live only in `.env`. The frontend never sees the key, and the access code is checked server-side with a constant-time comparison.
- **Rate limiting**: 20 AI calls per hour per IP (configurable), shared between plan generation and chat.
- **Server-side validation** of all input, and a prompt that treats free-text fields as data, not instructions.
- **Model fallback**: tries the models in `TEXT_MODELS` in order, with retries on overload.
- **Mock mode**: `MOCK_AI=1` returns a fixed example plan and fixed chat replies so the app can be tested without an API key. A chat message that asks for a change (e.g. contains "change") returns the example plan with one day changed.
- No build step, mobile friendly, light and dark theme.

## Run locally

```bash
cp .env.example .env        # then edit .env
npm test                    # run the unit tests
node server/index.js        # or: npm start
```

Open <http://localhost:3000>.

To try it without an API key, set `MOCK_AI=1` in `.env` (or run `MOCK_AI=1 node server/index.js`).
For real AI answers, set `GEMINI_API_KEY` (from [Google AI Studio](https://aistudio.google.com/apikey)) and `MOCK_AI=0`.

### Configuration (`.env`)

| Variable | Description |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API key. Server only. |
| `ACCESS_CODE` | Code users must enter before using the app. Empty = no code required. |
| `PORT` | Port to listen on (default 3000). |
| `TEXT_MODELS` | Comma-separated Gemini models, tried in order. |
| `RATE_LIMIT_PER_HOUR` | Calls per IP per hour (default 20). |
| `MOCK_AI` | `1` = return a fixed example plan, no API calls. |
| `TRUST_PROXY` | `1` = read the client IP from `X-Forwarded-For`. Enable only behind nginx. |

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | `{ status, needsCode, hasApiKey, mock }` |
| `POST /api/check-code` | Body `{ code }`. `200` if correct, `401` otherwise. |
| `POST /api/plan` | Body `{ code, profile }`. Returns `{ summary, weeklyPlan, nutrition, safetyNotes }`. |
| `POST /api/chat` | Body `{ code, profile, plan, history, message }`. `message` is 1-500 characters, `history` is at most 10 `{ role: "user" \| "assistant", text }` entries, `plan` is a plan as returned by `/api/plan`. Returns `{ reply, updatedPlan }`, where `updatedPlan` is a full plan (validated like `/api/plan` output) for change requests, or `null` for questions. If the message looks like a change request but the model returns no plan, the server asks the model once more. |

## Project layout

```
server/index.js      HTTP server, API routes, rate limit, Gemini client, static files
server/prompt.js     Builds the AI prompts (plan and chat)
server/chat.js       Chat logic: change-intent detection, retry, mock replies
server/mock.js       Example plan for MOCK_AI=1
server/validate.js   Validation of profile, chat messages and plan shape
server/*.test.js     Tests (node:test)
public/              Frontend (index.html, app.js, style.css)
```

## Deploy

The app is meant to run the same way as the **AWS level 3** setup: a Node process on an EC2 instance, with **nginx** in front as a reverse proxy.

1. Copy the repo to the instance, create `.env` with the real `GEMINI_API_KEY` and `ACCESS_CODE`, and set `TRUST_PROXY=1`.
2. Run `node server/index.js` as a service (systemd or pm2) so it restarts on failure and on reboot.
3. Point nginx at it:

   ```nginx
   server {
       listen 80;
       server_name _;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_read_timeout 180s;   # AI calls with retries can be slow
       }
   }
   ```

4. Keep port 3000 closed in the security group; only expose 80/443. Add HTTPS (for example with certbot) before sharing the access code with anyone.

`TRUST_PROXY=1` matters: without it every visitor appears to come from `127.0.0.1` and shares one rate limit bucket.

## Known limitations

- The rate limiter is in memory: it resets on restart and is not shared between instances.
- One shared access code, no user accounts.
- Saved only in this browser (localStorage). Not synced between devices. Anyone using the same browser profile can see the saved profile, plan and chat until "Clear" is pressed.
- Undo goes back one step only, and is not kept across a reload.
- Change requests are detected with a keyword list (change, replace, swap, make, increase, decrease, update, ändra, byt, ...). It only decides whether to ask the model a second time; whether the plan actually changes is still up to the model.
- The chat only remembers the last 10 messages, and long coach replies are cut to 500 characters when sent back as history.
- The plan is sent from the browser with each chat message, so the coach works from whatever plan the client sends (it is shape-checked, not verified against the original).
- AI output is shape-checked but not fact-checked. It is general fitness guidance, not medical advice.
- Prompt-injection defences (data delimiting, strict output shape) reduce risk but cannot guarantee the model ignores hostile text.
- A request can take a while in the worst case, since each model gets up to 3 attempts and a 40 s timeout, and a chat change request may be sent to the model twice.
- No end-to-end or browser tests; only validation, response checking and prompt building are unit tested.

## Included now

- **Chat coach**: follow-up questions about the plan ("swap squats for something knee-friendly"), with plan changes applied only on request.

## Next steps

- **Workout log**: record completed sessions, weights and reps.
- **History**: save earlier plans and progress, and feed them back into the next plan.
- **Server-side saving**: accounts and storage on the server, so plans follow you between devices.

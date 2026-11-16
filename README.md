# Gym AI Coach

A minimal web app where an AI coach turns your profile into a weekly training program and nutrition advice.
Plain Node.js (22+) with **zero npm dependencies**, a vanilla JS frontend and Google Gemini as the AI.

## Features

- **AI-generated plan**: a day-by-day program (exercises, sets, reps, rest) plus calorie/protein targets and nutrition tips, tailored to weight, height, age, sex, goal, training days, equipment, typical diet and injuries.
- **Secrets stay on the server**: the Gemini API key and the access code live only in `.env`. The frontend never sees the key, and the access code is checked server-side with a constant-time comparison.
- **Rate limiting**: 20 calls per hour per IP (configurable).
- **Server-side validation** of all input, and a prompt that treats free-text fields as data, not instructions.
- **Model fallback**: tries the models in `TEXT_MODELS` in order, with retries on overload.
- **Mock mode**: `MOCK_AI=1` returns a fixed example plan so the app can be tested without an API key.
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

## Project layout

```
server/index.js      HTTP server, API routes, rate limit, Gemini client, static files
server/prompt.js     Builds the AI prompt
server/validate.js   Profile validation
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
- One shared access code, no user accounts. Nothing is saved; a plan is lost when the page is reloaded.
- AI output is shape-checked but not fact-checked. It is general fitness guidance, not medical advice.
- Prompt-injection defences (data delimiting, strict output shape) reduce risk but cannot guarantee the model ignores hostile text.
- A request can take a while in the worst case, since each model gets up to 3 attempts and a 40 s timeout.
- No end-to-end or browser tests; only validation and prompt building are unit tested.

## Next steps

- **Workout log**: record completed sessions, weights and reps.
- **Chat coach**: follow-up questions about the plan ("swap squats for something knee-friendly").
- **History**: save earlier plans and progress, and feed them back into the next plan.

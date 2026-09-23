# Kalak (كَلَك) — a real-time trivia bluffing party game

A browser party game for 2–12 friends in the same room (or on the same Wi-Fi): everyone invents a fake answer to a trivia question, then tries to spot the real one among the bluffs. Built with Node.js, Express and Socket.io, with an Arabic-first (RTL) interface and an English question mode.

> Inspired by the Arabic party game *Kalak* and the "fibbing" genre of games such as *Fibbage*. This is an independent fan-made project for learning; it is not affiliated with the original game.

![Home, lobby, topic pick and writing a bluff](docs/screenshots/overview.png)

![Voting and the round reveal](docs/screenshots/round.png)

<p align="center"><img src="docs/screenshots/final-podium.png" width="300" alt="Final podium with confetti"></p>

*Screenshots from a local 3-player session (three separate browser sessions on one machine), with the room set to English questions.*

---

## How to play

If you have never played a Kalak/Fibbage-style game, here is the idea:

1. **Create a room.** One player (the host) creates a room and gets a 5-character code. Friends open the same address on their phones, type the code (or open the share link), pick an avatar and a name.
2. **Pick a topic.** Each round, one player takes a turn choosing the category (Geography, History, Science, Sports, Food, Flags...). If they take longer than 15 seconds, one is picked at random.
3. **Write a bluff.** Everyone sees an obscure-sounding question, e.g. *"Deepest point in the ocean?"*. You don't answer it truthfully. You write a **convincing fake answer** ("Puerto Rico Trench") to trick the others.
4. **Find the truth.** The real answer is shuffled in with all the bluffs. Everyone votes for the one they think is real.
5. **Reveal.** The game shows which answer was real, who wrote each bluff, and who fell for it.

**Scoring**

| Event | Points |
| --- | --- |
| You vote for the real answer | +2 |
| Another player votes for *your* bluff | +1 per player fooled |

You can't vote for your own bluff (it is greyed out). If you type the real answer by accident, the game tells you and lets you write a fake one instead. If two players write the same bluff (ignoring case, spacing and accents/harakat), it appears once and both authors get the points.

After the last round, a podium shows the top three (players with equal scores share a place) and the host can start a new game with the same group.

## Features

- **Rooms with join codes**: 5-character codes (without look-alike characters such as `0/O` or `1/I`), a copy button and a `?room=CODE` share link.
- **Real-time multiplayer over WebSockets**: lobby, timers, answer and vote counters ("2/3 answered") update live on every screen.
- **Reconnect and resume**: reloading the page or losing the connection puts you back in the same seat with the same score, even mid-game (see [Reconnecting](#reconnecting)).
- **Nobody gets stuck**: if a player leaves mid-round, the round moves on as soon as everyone still connected has answered/voted; if the host leaves, another player becomes host and gets the Next / Play again buttons.
- **Host settings**: categories, number of rounds (1–30), answer time (10–120 s), vote time (10–60 s), max players and language. The language applies to the whole room: questions *and* every player's interface (text and RTL/LTR direction) switch together.
- **Rotating topic picker**: the player who picks the category changes each round.
- **Round breakdown**: the question, every answer, who wrote it and who voted for it, plus round points and a running scoreboard.
- **Lobby chat**, avatar picker (30 emoji avatars, a random one by default), kick button for the host.
- **Final podium** with a CSS confetti animation.
- **Mobile-first UI** in Arabic (RTL) and English (LTR), Cairo + Fredoka fonts, designed to be played on phones around a table.
- **No database and no accounts**: all game state lives in server memory.

## Question bank

The questions are a **hand-written, hard-coded list in `lib/questions.js`** (the `QUESTIONS` object). There is no external trivia API or database. There are **13 categories × 25 questions = 325 questions**, each stored in Arabic *and* English (`q`/`a` and `qE`/`aE`), so the host can switch the language of the questions. Each question has exactly one clean answer per language (the one shown in the vote list); other accepted spellings go in `alt` / `altE` and are only used to detect a player typing the real answer. A question is never asked twice in the same game: when the chosen topic runs out, another enabled topic is used, and when every enabled topic is used up the game ends normally with the podium.

Categories: General, Geography, History, Science, Sports, Entertainment, Technology, Food, Islam, Arab world, Literature, Animals, Flags.

## How it works

### Architecture

```
 phones / browsers (public/)                 Node.js server (server.js)
 ┌──────────────────────────┐   Socket.io   ┌──────────────────────────────┐
 │ index.html  (screens)    │ ◄───────────► │ Express: serves public/      │
 │ game.js     (UI + events)│   WebSocket   │ Socket.io: game events       │
 │ style.css                │               │ rooms: Map<code, Room>       │
 └──────────────────────────┘               │ lib/logic.js: rules (pure)   │
                                            │ lib/questions.js: 325 Q/A    │
                                            └──────────────────────────────┘
```

The server is the single source of truth. Clients only send intents (create/join, answer, vote...). The server validates every payload (settings are whitelisted and clamped, text is trimmed and capped at 60 characters, votes for your own bluff are refused), advances the game and pushes the new state to everyone in the room. Every socket handler and timer callback is wrapped so that one malformed event is logged instead of crashing the process. Correct answers are never sent to clients before the reveal. Vote options are sent as `{ id, text, own }` only, without who wrote them.

### Game state machine (per room)

```
 lobby ──game:start──► picking ──category chosen / 15 s──► question
   ▲                     ▲                                    │ all answered / answer timer
   │                     │ game:next (rounds left)            ▼
   │                  results ◄──all voted / vote timer──── voting
   │                     │ game:next (last round)
   └──game:restart── finished
```

A single server-side interval timer per room drives each phase (`setTimer`) and broadcasts `timer:update` every second. A phase also ends early as soon as every *connected* player has answered or voted; this is re-checked whenever someone disconnects or leaves, and if the topic picker leaves, a random topic is chosen right away.

### Socket.io event flow

| Direction | Event | Purpose |
| --- | --- | --- |
| client → server | `room:create`, `room:join`, `room:resume`, `room:leave` | create / join / rejoin / leave a room (with an ack callback) |
| client → server | `room:settings`, `room:kick` | host changes settings / removes a player |
| client → server | `game:start`, `game:next`, `game:restart` | host controls the flow |
| client → server | `game:pickCategory` | current picker chooses the topic |
| client → server | `game:answer`, `game:vote` | submit a bluff / a vote (the ack says why it was refused: `real`, `own`...) |
| client → server | `chat:send` | lobby chat |
| server → clients | `room:state` | full room snapshot (players, scores, settings, host) |
| server → clients | `game:pick`, `game:question`, `game:vote`, `game:results`, `game:end` | phase changes |
| server → clients | `timer:update`, `game:answered`, `game:voted`, `chat:msg` | live counters, timer, chat |
| server → clients | `session:replaced`, `kicked` | the seat was taken over by another tab / the host removed you |

A bluff equal to the real answer (or one of its accepted alternatives, in either language) is refused when it is submitted. When voting starts, bluffs that are equal once case, spacing, punctuation, accents/harakat, Arabic letter variants and leading articles are ignored are merged into one option that credits every author. The real answer and the bluffs are then shuffled (Fisher–Yates) before they are sent out.

### Reconnecting

Each browser gets a random **player token** stored in `localStorage` (`kalak_token`), together with the room it is in (`kalak_session`). The token is sent when creating or joining a room and is never shown to other players (they only see a separate public player id).

- When a socket disconnects, the player's seat is kept for **60 seconds** and shown as offline. Offline players don't count toward the room's player limit, aren't waited for, and aren't picked to choose the topic.
- On page load, and whenever Socket.io reconnects, the client sends `room:resume { code, token }`. The server re-attaches the socket to the same seat (same score, same answer/vote if already given) and re-sends the current phase (topic pick, question, vote list, results or podium) plus the timer.
- Joining the same room again through the join form from the same browser also resumes the seat instead of creating a duplicate, so "Game already started" only applies to new players.
- If the same token connects from a second tab, the newest tab takes the seat and the old one shows "The game was opened in another tab". (To test several players on one computer, use separate browser profiles or private windows.)
- After 60 seconds without reconnecting, the seat is removed: it disappears from the scoreboard and the podium. A player who taps **Home** leaves right away.
- If the host disconnects, the first connected player becomes host immediately (and keeps it if the old host comes back).
- Kicks are stored by token, so a kicked player can't rejoin that room by picking another name.

## Run locally

Requirements: [Node.js](https://nodejs.org/) 18+ (tested with Node 22).

```bash
npm install
npm start            # http://localhost:3000
```

The port can be changed with the `PORT` environment variable:

```bash
PORT=3105 npm start          # macOS / Linux / Git Bash
$env:PORT=3105; npm start    # Windows PowerShell
```

### Tests

```bash
npm test
```

Runs Node's built-in test runner (`node:test`, no test framework needed):

- `test/logic.test.js`: unit tests for the pure rules in `lib/logic.js` (settings validation, answer normalisation and merging, scoring, tied ranks, question picking) and a check that every question has one clean answer.
- `test/server.test.js`: end-to-end tests that start the real server on port **3609** (override with `KALAK_TEST_PORT`) and play through it with `socket.io-client`: malformed and previously crashing payloads, full rounds, reload and resume, grace-period expiry, players and the host leaving mid-game, kicks, and running out of questions.

### Playing on a LAN

The server listens on all network interfaces, so phones on the same Wi-Fi can join:

1. Find the host computer's local IP (`ipconfig` on Windows, `ip addr` / `ifconfig` on macOS/Linux), e.g. `192.168.1.20`.
2. On each phone, open `http://192.168.1.20:3000`.
3. One person creates the room; the others tap **Join** and type the code.

You may need to allow Node.js through the computer's firewall.

## Project structure

```
.
├── server.js          # Express + Socket.io server: rooms, seats/reconnects, game flow
├── lib/
│   ├── logic.js       # pure rules: settings validation, answer matching, scoring, ranking
│   └── questions.js   # question bank (Arabic + English)
├── public/
│   ├── index.html     # all screens (landing, profile, lobby, pick, question, vote, results, final)
│   ├── game.js        # client: translations, screens, socket events, reconnect, rendering
│   ├── style.css      # dark, mobile-first RTL/LTR theme and animations
│   └── favicon.svg
├── test/              # node:test unit tests + socket.io end-to-end tests
├── docs/screenshots/  # README images
└── package.json
```

## Tech stack

- **Backend:** Node.js, Express 4, Socket.io 4
- **Frontend:** plain HTML, CSS and JavaScript (no framework, no build step), Socket.io client
- **Tests:** `node:test` + `socket.io-client`
- **Fonts:** Cairo and Fredoka (Google Fonts)

## Known limitations

- All state is kept in memory. Restarting the server ends every game (players are sent back to the home screen).
- New players can't join a game that has already started; they can join the next one from the lobby.
- Detecting the real answer is text-based (case, accents, harakat, digits and simple number words are normalised), so a creative synonym of the real answer can still get through as a bluff.
- A few question-bank entries are debatable or duplicated.

## License

© 2026 Hamza Ben Ismail. All rights reserved.

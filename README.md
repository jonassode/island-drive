# Island Drive

A tiny web game: every page load procedurally generates a new 3D island, drops a car on it
and lets you drive around with the arrow keys.

It is also **multiplayer**: several players share one island over a WebSocket, race around it
at the same time, and each gets a random car colour. Nothing is persisted — no database, no
accounts, no lobby — the server holds a room in memory for as long as somebody is in it.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173 — solo, or open a second tab to play together
```

Open a second browser tab (or the same URL on another machine) and you are in the same room.
Other commands:

```bash
npm test         # unit + socket tests (no browser needed)
npm run build    # production bundle into dist/
npm run preview  # serve the built bundle (and the game socket) on :4173
npm start        # production: node server/index.js serves dist/ and the socket on :4173
```

Development and preview attach the multiplayer server to Vite itself, so there is no second
process to start. `npm start` is the deployment story: one process, one port, serving `dist/`
plus the socket. The bundle is a plain static site, so hosting `dist/` anywhere without the
server works too — a page whose socket never connects simply plays alone.

### Rooms and URLs

| URL | What you get |
| --- | --- |
| `/` | the shared default room (`MULTIPLAYER.room`) |
| `/?room=abc` | a specific room, so a group can meet somewhere private |
| `/?seed=12345` | the island with that seed, shared with anyone using the same link |
| `/?solo=1` | no socket at all: the single player game |
| `/?name=Ana` | a display name (otherwise you are `Driver 1`, `Driver 2`, …) |

## Verifying

Three layers of checks, all fast:

```bash
npm test          # 127 tests: the pure modules plus the room and the socket, no browser
npm run preview & # serve dist/ on :4173
npm run smoke     # drives the real page in headless Chrome, two players and all
```

`npm run smoke` (see `scripts/smoke.mjs`) has **no npm dependencies** — it speaks the
Chrome DevTools protocol directly over Node's built-in `fetch`/`WebSocket`, dispatches real
arrow-key events and asserts the whole feature set end to end: island generation and seed
reproducibility, the car resting on the rendered terrain (not floating), the height
distribution of the island, the dirt path looping the island without touching the sea,
jumping off crests, smashing trees, drowning in the sea, and all four arrow keys. It also
writes four screenshots (`/tmp/car-game-smoke.png`, `car`, `path`, `island`) and it is what caught
most of the bugs during development: a floating chassis, wheels hanging over bumps, a washed
out environment map, an island coloured entirely in rock, and a car that floated a quarter of
the time. It skips itself cleanly if no Chrome is found (`CHROME_PATH` / `SMOKE_URL` override
the defaults).

The multiplayer checks open a **second tab** and watch the two of them from the outside: one
page drives, and the other is asked where it thinks that car is. The tab in front is the only
one Chrome keeps animating, so the driver's tab is brought forward to drive and the observer's
to be read — a detail worth knowing before debugging a "frozen" background tab.

The two island-dependent checks deliberately load **pinned seeds** (`/?seed=1`, `7` and `99`)
instead of the random island a page load normally draws. That matters: the same jump tuning
used to pass or fail depending on which island a run happened to get. Seed 99 is the island on
which the car never left the ground at all until `CAR.launchGravity` was lowered, so those
seeds are kept as regression cover — and each pinned seed gets a room of its own, so those
pages never meet.

## Deploy

`npm start` is a complete deployment by itself: one process, one port, serving `dist/` and the
socket. `render.yaml` is a [Render Blueprint](https://render.com/docs/blueprint-spec) that runs
it on Render's **free** web service plan, and two GitHub Actions workflows publish it:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `.github/workflows/ci.yml` | pull request | `npm test`, `npm run build`, then `npm run smoke` in headless Chrome against `vite preview` (advisory — see below) |
| `.github/workflows/deploy.yml` | push to `main` | runs the CI workflow, then POSTs the Render deploy hook |

One-time setup:

1. Render Dashboard → *New* → *Blueprint*, and pick this repository. That creates the service
   from `render.yaml`.
2. Copy the service's **Deploy Hook** URL into a repository secret named
   `RENDER_DEPLOY_HOOK_URL` (Settings → Secrets and variables → Actions). It cannot be committed,
   and the deploy job fails with a message saying so if it is missing.

Worth knowing before pointing people at it:

- **One instance, always.** Rooms live in a `Map` inside the process, so two instances would each
  hold their own island under the same room id and split the players between them. The free plan
  cannot scale past one instance, which is why `numInstances` is not raised above 1 in the
  Blueprint — on a paid plan it would have to stay there, or the room would need to move out of
  process memory.
- **Free instances sleep.** After 15 minutes without inbound traffic Render spins the service
  down, and the next visitor waits roughly a minute for it to come back. Traffic on an existing
  WebSocket counts, so a game in progress keeps it awake — and nothing is lost when it does
  sleep, because a room is only an island plus whoever is in it.
- **Bandwidth.** A page load is about 600 KB, against 5 GB/month included on the Hobby workspace.
- **If a full room ever outruns the free instance**, the server reads `TICK_RATE` (Hz, 10-60) and
  `MAX_ROOMS` from the environment. Clients adopt the rate from the server's `welcome`, so
  lowering it costs nothing but a redeploy — see the commented-out `envVars` in `render.yaml`.
- **The CI smoke run is advisory, on purpose.** GitHub's runners have no GPU, so the software
  rasterizer draws this island at well under one frame per second; the checks that hold a key
  down and wait in real time then see the car creep, because the game caps how far a frame may
  catch up (`MAX_STEPS_PER_FRAME`). The checks that step the simulation directly report exactly
  as they do locally, so the run is still worth reading — but `npm test`, the build and a local
  `npm run smoke` are what actually decide whether a change is good.
- **Static hosting works too** (Cloudflare Pages, GitHub Pages, S3, …): `dist/` is a plain static
  site, `vite.config.js` sets `base: './'` so it runs from a sub-path, and a page whose socket
  never connects simply plays alone. Multiplayer is the only thing given up.

## Controls

| Key | Action |
| --- | --- |
| `↑` | accelerate (`W` also works) |
| `↓` | brake, then reverse (`S`) |
| `←` / `→` | steer (`A` / `D`) |
| `R` | generate a **new island** (in a room: only the host may) |
| `Space` | jump back to the spawn point |

## How it works

```
index.html          canvas + HUD overlay
src/main.js         bootstrap + game loop (input -> physics -> mesh -> camera -> render)
src/config.js       every tunable: world, car, camera, colours, sky, props, path, multiplayer
src/input.js        keyboard state (arrow keys, WASD alias, R, space)
src/camera.js       damped chase camera that keeps itself above the terrain
src/hud.js          speed / seed / room / roster / status readout
src/world/rng.js    mulberry32: the seedable PRNG that makes islands reproducible
src/world/heightfield.js  procedural terrain (pure, headless-testable)
src/world/island.js       terrain mesh + vertex colours (sand -> grass -> rock -> snow)
src/world/water.js        animated ocean plane + sea floor
src/world/sky.js          Preetham sky, sun light, shadows, fog
src/world/props.js        instanced trees and rocks drawn from propSpots
src/game/propSpots.js     where the scenery goes (pure: shared by the renderer and the server)
src/world/pathField.js    the closed loop the dirt path follows (pure, headless-testable)
src/world/path.js         the dirt ribbon, laid on the terrain along that loop
src/game/treeField.js     spatial index the car queries for nearby trees (pure)
src/car/carModel.js       the car, built from primitives, painted per player
src/car/carTransform.js   physics state -> body tilt, suspension and wheel roll (shared by all cars)
src/car/carDebris.js      the foliage shards thrown by a smashed tree
src/car/carPhysics.js     arcade bicycle-model driving (pure, headless-testable)
src/car/carPose.js        fits the body to the ground under its wheels (pure, headless-testable)
src/multiplayer/protocol.js    the wire format, both directions (pure)
src/multiplayer/palette.js     picking an unused car colour for a player (pure)
src/multiplayer/prediction.js  input history, rollback and replay for the local car (pure)
src/multiplayer/net.js         the client socket: connect, reconnect, send
src/multiplayer/remoteCars.js  other players' cars, interpolated from snapshots
server/room.js           the authoritative simulation of one island (no sockets, testable)
server/socketServer.js   rooms, connections, the tick loop
server/index.js          production: dist/ + the socket on one port
tests/                   Vitest specs for the pure modules, the room and the socket
render.yaml              Render Blueprint: one free web service (see Deploy)
.github/workflows/       CI, and the deploy that runs it (see Deploy)
```

The island is a seeded fBm noise field shaped by a radial falloff, so it is always
surrounded by water. `heightfield.heightAt(x, z)` is the single source of truth: the terrain
geometry is generated from it *and* the car samples it every frame, so the car can never
disagree with the visible ground (and no raycasting is needed).

On top of that falloff the island is built from a flat grassy lowland plus **sparse, randomly
placed hills** — 40 of them, 70-180 units in radius, never piled into one central peak. The
number that matters most is `WORLD.hillCount`, because the hills *sum*: a hill count high
enough for their footprints to blanket the island merges them into a single plateau pinned at
`WORLD.hillHeightCap`, which turns the whole interior into rock and snow and flattens
everything the car was meant to jump off.

Around that runs a **dirt path**: a single closed loop of trodden earth. It is placed by
measurement rather than by eye — over 40 seeds and 720 directions, dry land always reaches at
least 0.709 of `islandRadius`, and the loop (at `PATH.radius` = 0.6 of it) stays inside 0.64
even with its wobble, which leaves ~70 u of land between the outside of the track and the
waterline at its worst spot. So it wraps the island's flank: far enough out to read as a lap of
the island, far enough in never to touch the beach. Every station samples the same height field
the car drives on, so it goes *over* the hills and climbs them like the car does, and it is
deliberately not cleared of trees — it runs *under* the canopy, and a tree standing in the
track is just another tree to smash. It is scenery: it changes nothing about how the car
drives.

Driving is an arcade bicycle model — throttle/brake, a speed-dependent yaw rate derived from
the front wheel angle, rolling resistance, and gravity projected along the slope so hills
actually slow you down. It is deliberately more than a flat-plane car:

- **Hills launch the car.** The terrain's vertical velocity under the car is tracked and
  smoothed; when it falls away faster than `CAR.launchGravity` while the car is above
  `CAR.launchMinSpeed` (30 u/s, ~108 km/h), the car leaves the ground carrying its climb rate
  and becomes a plain projectile under `CAR.airGravity` until it lands. Landing hard scrubs a
  little speed.
- **Trees are solid until 50 km/h.** Below `CAR.breakSpeedKmh` a tree stops the car and
  bounces it back; above it the tree is smashed, throws `src/car/carDebris.js` shards, and
  the car keeps 82% of its speed.
- **The sea is a fail state.** Driving in is allowed, so it looks like driving in, but the
  water drags the car to a stop and after `CAR.waterRespawnDelay` it is put back on the last
  flat, dry spot it was on (`state.lastSafe`), which is updated as you drive.

There is no physics engine and no binary asset anywhere in the project.

Details worth knowing if you change things:

- **Lighting** is a Preetham `Sky` plus *image based lighting*: the sky is baked with
  `PMREMGenerator` and assigned to `scene.environment`, which is what makes the car paint
  and the water reflect something. The sun disc is hidden (`showSunDisc = 0`) during that
  bake — it is tens of thousands of units bright and otherwise floods the whole scene.
- **The car is fitted to the ground with four samples**, not one: `src/car/carPose.js` fits a
  plane through the terrain under each wheel, in the car's *own* frame, and gives every wheel
  up to `CAR.suspensionTravel` of independent vertical travel. Without that, a rigid body
  visibly hovers over bumps. Two caps keep that fit from rolling the car over, and both rotate
  the body *inside* the plane it is already leaning in, so a cap can only ever make it lean
  less: one is relative to the terrain's own normal (`CAR.maxTiltDeviation` — a kerb edge or a
  rock narrower than the car trips it, a plain hillside never does: measured on 0% of some
  60,000 samples across four seeds) and one is absolute (`CAR.maxTilt`, set above the ~52° that
  is the steepest ground these islands produce). Reading the roll off named wheel pairs instead
  is easy to get backwards, and it was: the car used to bank *into* every side slope, 58° off
  the ground on a 29° hill. `tests/carPose.test.js` pins the sign, the caps and the wheel
  travel.
- **The sea has a floor.** The translucent water surface would otherwise reveal the rim of
  the square terrain grid as a lighter square; a plane just below it hides the seam, and the
  underwater terrain is tinted to the same colour. That floor and the water surface are the
  only things the fog has to hide, and the fog is far closer than they are.
- **The water does not receive shadows.** The shadow frustum is a couple of hundred units
  wide and follows the car, while the ocean plane is 7000 units across, so receiving shadows
  painted the frustum's square edge onto open water as a dark rectangle. Nothing is ever
  shadowed onto water anyway: the car respawns rather than floating.
- **Feel is tuned from measured statistics, not by eye.** `tests/heightfield.test.js` pins the
  island's height distribution, `tests/carPhysics.test.js` pins the launch/landing rules,
  `tests/carPose.test.js` pins the body's fit to the ground (and the sign of every lean), and
  `scripts/smoke.mjs` drives the real page and reports launches per minute, longest flight
  and what share of a 60-second run the car spends airborne. Those numbers — not a screenshot
  — are what set `CAR.launchGravity` (34) and `CAR.airGravity` (34): a lower launch threshold
  lets a fast car skate along above the ground for seconds, and a lower air gravity makes the
  whole island feel like the moon.
- **The dirt path is a ribbon, not a texture.** `src/world/path.js` sweeps a strip of vertices
  around the loop and samples `heightAt()` at every one of them, which is why it can climb a
  hillside without ever leaving it. Two details keep it from misbehaving: it is lifted
  `PATH.lift` above the ground and pulled a hair further towards the camera in the depth test
  (a polygon offset), because the terrain's 6.25 u cells interpolate linearly and a ribbon laid
  exactly on the field would sink under the mesh in every hollow; and it *crowns* along its
  centre, which puts the parts of the ribbon whose alpha has reached zero down against the
  terrain, where a gap would actually be visible. The soft edge is vertex *alpha* (a
  four-component colour attribute) rather than a hard cut, which is why the material is
  translucent and does not write depth — a fully faded rim must not clip the sea behind it.
  `tests/pathField.test.js` pins the loop itself (closed, single, on land, over hills) and
  `scripts/smoke.mjs` re-checks it in the live page, including that every ribbon vertex is
  0.05-0.4 u above the height field it was built from.

## Multiplayer

One room is one island, and the island is **not** sent over the wire. It is regenerated on
every client from a single seed, which is the whole reason a session costs almost nothing: the
terrain, the trees and the dirt path are all functions of that number, and both ends already
had the functions.

```
   browser  ── /ws ──►   server/room.js      60 Hz: stepCar() per player (pure modules, no three.js)
  predicts its            ids, colours,      20 Hz: snapshot { poses, ack, treeBreak events }
  own car                 spawn slots        empty room -> dropped, nothing persisted
```

**The server is authoritative.** Clients send four booleans — up, down, left, right — one per
tick, and nothing else. The server runs the *same* `stepCar()` the browser does, at the same
fixed 60 Hz, and answers with where everyone is. A client cannot be somewhere the server says
it is not.

**The client predicts.** Since the client runs the same simulation over the same island, it
also runs its own car immediately rather than waiting for a round trip: input goes on screen in
the same frame it is pressed. Each tick's input is recorded against a sequence number, and when
a snapshot arrives the car is rolled back to the server's state and the inputs the server has
not acknowledged yet are replayed. That is why the physics runs on a fixed-step accumulator
instead of the frame rate — the replay has to be *exactly* re-simulating, not approximately.
`tests/prediction.test.js` asserts it lands on the same numbers, and that a 15 second run
through the forest never drifts further than a nudge.

**Corrections are hidden.** What is left over after a replay is not applied to the car
directly: it is added to the drawn position and decays over a few frames, so a correction is a
slight slide. Only a correction too big to hide (`MULTIPLAYER.snapDistance`) is taken at once,
and only when something real happened — a respawn, a new island, a long stall.

**Other cars are interpolated.** Snapshots arrive at 20 Hz while the screen draws at whatever
it likes, so every arrival is buffered and each car is drawn a fixed 120 ms behind the newest
one, interpolating between the two snapshots that straddle that moment. The delay is what
absorbs a late packet: as long as the stream is jittery rather than slower than the delay,
there is always a pair to draw between.

**Trees are the server's.** A client's own car resolves collisions against a read-only tree
registry: it takes the same hit — and therefore the same speed loss, so the two simulations
agree tick for tick — but it does not remove anything. The tree actually disappears when the
server says so, in a snapshot event, and everyone sees the same wreckage at the same moment.
`tests/propSpots.test.js` checks the load-bearing part: the server's meshes-less tree list and
the one the renderer draws are identical, tree for tree, on every pinned seed.

**Identity is per connection.** Each player gets the next free id, the next free spawn slot
(rings around the island's own spawn point, inside the tree-free zone, facing the way the dirt
path runs) and a random colour nobody else in the room is using — eight paints, eight players,
so a full room is eight different colours. Names come from `?name=`. All of it is forgotten the
moment the socket closes.

**`R` belongs to the host.** Regenerating the island regenerates it for everyone, so only the
first player in the room can do it, and the others are told. `Space` respawns you alone.

The protocol is in `src/multiplayer/protocol.js` and is deliberately boring: JSON, a handful of
message types, and a parser that treats anything unrecognised as `null` rather than an
exception — the server runs whatever a stranger sends it. A snapshot is a couple of hundred
bytes per car twenty times a second, which at eight players is a few kilobytes a second each
way; readability was worth more than a binary format.

## Reproducible islands

The seed is written into the URL (and shown in the HUD):

- `http://localhost:5173/?seed=12345` always generates the same island.
- `R` picks a new random seed and updates the URL — solo. In a room the island belongs to the
  room, so the address bar is left alone and the HUD reports the room instead.

## Tuning

Everything lives in `src/config.js`. Handy starting points:

| Want to change | Knobs |
| --- | --- |
| Island size / shape | `WORLD.islandRadius`, `WORLD.size`, `WORLD.baseHeight` |
| How hilly it is | `WORLD.hillCount`, `hillRadiusMin/Max`, `hillHeightMin/Max` |
| Colours (grass vs rock vs snow) | `ISLAND.sandHeight`, `grassHeight`, `snowHeight` |
| How the car drives | `CAR.maxSpeed`, `accel`, `brake`, `maxSteer` |
| How it tilts on hills | `CAR.maxTilt`, `CAR.maxTiltDeviation`, `CAR.suspensionTravel` |
| How it jumps | `CAR.launchMinSpeed`, `launchGravity`, `airGravity`, `launchMaxSpeed` |
| Trees | `PROPS.trees`, `PROPS.clusters`, `PROPS.maxHeight` (how high up they grow) |
| The dirt path | `PATH.radius`, `PATH.wobble` (its outline), `PATH.halfWidth`, `PATH.lift` |
| Tree wrecking | `CAR.breakSpeedKmh`, `breakSlowdown` |
| Drowning | `CAR.waterRespawnDelay`, `waterDrag` |
| The view | `CAMERA.distance`, `CAMERA.height`, `CAMERA.damp` |
| How many players | `MULTIPLAYER.maxPlayers` (and `colors`, which should match it) |
| How snappy it feels online | `MULTIPLAYER.tickRate`, `snapshotRate`, `interpDelayMs` |
| How corrections behave | `MULTIPLAYER.snapDistance`, `errorDecay`, `replayMaxTicks` |
| Input traffic | `MULTIPLAYER.inputBatch`, `maxInputsPerMessage` |
| Which island a room gets | `MULTIPLAYER.room` (the default room name) |

`MULTIPLAYER.tickRate` is the one to be careful with: the server simulates at it and the client
*replays* at it, and both take it from the same constant — the client is also told the server's
rate in `welcome`, so the two can never disagree about it. Raising it costs CPU on the server
(one `stepCar()` per player per tick) and buys nothing above 60, since that is already the rate
the physics was tuned at.

When you retune the terrain, run `npm test` and `npm run smoke`: those two are what stop the
island from quietly collapsing back into a featureless dome.

The jump tuning deserves the same treatment, and it is cheap to get right because the physics
is pure: a full-throttle run can be stepped headlessly. `CAR.launchGravity` (20), `CAR.airGravity`
(60) and `WORLD.detailAmplitude` were all picked from 60 second runs over seeds 1, 3, 7, 11, 42
and 99, scored on launches per run, longest flight and airborne share — the numbers are in the
comments on those constants, and `tests/carPhysics.test.js` re-runs the sweep so a change that
makes the car stop flying (or start gliding for seconds) fails a test rather than just feeling
slightly off.

## Notes / limitations

- Desktop keyboard only; no touch controls.
- Multiplayer is **not** persistent, by design: no database, no accounts, no lobby, no
  reconnection grace period. A room lives in memory while somebody is in it and is gone when
  the last player leaves, taking its island and its tree wreckage with it. A dropped socket
  means a new id and a new colour on reconnect.
- Cars pass through each other: there is no car-to-car collision, and no way to punt somebody
  off the road. Adding it means a resolver in `carPhysics.js` plus tests, and it would have to
  be deterministic on both sides of the wire to survive prediction.
- A tree can look solid for one snapshot (~50 ms) after the server has smashed it, because the
  removal arrives in the next snapshot rather than with the hit. A client's own smash may also
  cost a little extra speed until the server confirms it, which the next snapshot corrects
  invisibly.
- The shadow map follows only the local car, so a car further up the island loses its shadow.
- Every car is ~13 meshes, so a full room of eight is ~100 extra draw calls. Fine on anything
  with a GPU; it would be the first thing to instance if the room grew.
- One room per island, one island per room, and a room is capped at `MULTIPLAYER.maxRooms`
  islands in memory at once.
- Water is a simple animated plane rather than `three`'s `Water` addon, whose normal map is
  not shipped inside the npm package and would 404.
- The car is procedural, not a loaded `.glb`. To swap in a real model, replace
  `buildCar()` in `src/car/carModel.js` with a `GLTFLoader` call that returns the same
  contract: `{ group, wheels[], steerPivots[], suspension[], wheelOffsets[] }`.
- Collision is intentionally limited: trees and the waterline, no car-to-car or car-to-rock
  collision, and no rollover — the chassis follows the ground it is standing on, capped at
  `CAR.maxTilt` but never flipping.
- The dirt path is scenery only: no different grip, no smoothing of the bumps under it, and no
  effect on anything the physics sees. Trees are not cleared from it either, so it really does
  run under the canopy and through whatever is standing in the way.
- The island is one continuous landmass. The falloff guarantees water all around it, but it
  does not carve inland lakes.

# Island Drive

A tiny web game: every page load procedurally generates a new 3D island, drops a car on it
and lets you drive around with the arrow keys.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

Other commands:

```bash
npm test         # unit tests (terrain + car physics, no browser needed)
npm run build    # production bundle into dist/
npm run preview  # serve the built bundle
```

## Verifying

Two layers of checks, both fast:

```bash
npm test          # 41 unit tests over the three pure modules, no browser needed
npm run preview & # serve dist/ on :4173
npm run smoke     # drives the real page in headless Chrome
```

`npm run smoke` (see `scripts/smoke.mjs`) has **no npm dependencies** — it speaks the
Chrome DevTools protocol directly over Node's built-in `fetch`/`WebSocket`, dispatches real
arrow-key events and asserts the whole feature set end to end: island generation and seed
reproducibility, the car resting on the rendered terrain (not floating), the height
distribution of the island, jumping off crests, smashing trees, drowning in the sea, and all
four arrow keys. It also writes three screenshots (`/tmp/car-game-smoke.png`, `car`,
`island`) and it is what caught most of the bugs during development: a floating chassis,
wheels hanging over bumps, a washed out environment map, an island coloured entirely in
rock, and a car that floated a quarter of the time. It skips itself cleanly if no Chrome is
found (`CHROME_PATH` / `SMOKE_URL` override the defaults).

The two island-dependent checks deliberately load **pinned seeds** (`/?seed=1`, `7` and `99`)
instead of the random island a page load normally draws. That matters: the same jump tuning
used to pass or fail depending on which island a run happened to get. Seed 99 is the island on
which the car never left the ground at all until `CAR.launchGravity` was lowered, so those
seeds are kept as regression cover.

## Controls

| Key | Action |
| --- | --- |
| `↑` | accelerate (`W` also works) |
| `↓` | brake, then reverse (`S`) |
| `←` / `→` | steer (`A` / `D`) |
| `R` | generate a **new island** |
| `Space` | jump back to the spawn point |

## How it works

```
index.html          canvas + HUD overlay
src/main.js         bootstrap + game loop (input -> physics -> mesh -> camera -> render)
src/config.js       every tunable: world, car, camera, colours, sky, props
src/input.js        keyboard state (arrow keys, WASD alias, R, space)
src/camera.js       damped chase camera that keeps itself above the terrain
src/hud.js          speed / seed / status readout
src/world/rng.js    mulberry32: the seedable PRNG that makes islands reproducible
src/world/heightfield.js  procedural terrain (pure, headless-testable)
src/world/island.js       terrain mesh + vertex colours (sand -> grass -> rock -> snow)
src/world/water.js        animated ocean plane + sea floor
src/world/sky.js          Preetham sky, sun light, shadows, fog
src/world/props.js        instanced trees and rocks, and smashing a tree
src/game/treeField.js     spatial index the car queries for nearby trees (pure)
src/car/carModel.js       the car, built from primitives
src/car/carDebris.js      the foliage shards thrown by a smashed tree
src/car/carPhysics.js     arcade bicycle-model driving (pure, headless-testable)
tests/                    Vitest specs for the three pure modules
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
- **The car is fitted to the ground with four samples**, not one: `updateCarMesh()` samples
  the terrain under each wheel, derives the body's height/orientation from that plane, and
  gives every wheel up to `CAR.suspensionTravel` of independent vertical travel. Without
  that, a rigid body visibly hovers over bumps.
- **The sea has a floor.** The translucent water surface would otherwise reveal the rim of
  the square terrain grid as a lighter square; a plane just below it hides the seam, and the
  underwater terrain is tinted to the same colour. That floor and the water surface are the
  only things the fog has to hide, and the fog is far closer than they are.
- **The water does not receive shadows.** The shadow frustum is a couple of hundred units
  wide and follows the car, while the ocean plane is 7000 units across, so receiving shadows
  painted the frustum's square edge onto open water as a dark rectangle. Nothing is ever
  shadowed onto water anyway: the car respawns rather than floating.
- **Feel is tuned from measured statistics, not by eye.** `tests/heightfield.test.js` pins the
  island's height distribution, `tests/carPhysics.test.js` pins the launch/landing rules, and
  `scripts/smoke.mjs` drives the real page and reports launches per minute, longest flight
  and what share of a 60-second run the car spends airborne. Those numbers — not a screenshot
  — are what set `CAR.launchGravity` (34) and `CAR.airGravity` (34): a lower launch threshold
  lets a fast car skate along above the ground for seconds, and a lower air gravity makes the
  whole island feel like the moon.

## Reproducible islands

The seed is written into the URL (and shown in the HUD):

- `http://localhost:5173/?seed=12345` always generates the same island.
- `R` picks a new random seed and updates the URL.

## Tuning

Everything lives in `src/config.js`. Handy starting points:

| Want to change | Knobs |
| --- | --- |
| Island size / shape | `WORLD.islandRadius`, `WORLD.size`, `WORLD.baseHeight` |
| How hilly it is | `WORLD.hillCount`, `hillRadiusMin/Max`, `hillHeightMin/Max` |
| Colours (grass vs rock vs snow) | `ISLAND.sandHeight`, `grassHeight`, `snowHeight` |
| How the car drives | `CAR.maxSpeed`, `accel`, `brake`, `maxSteer` |
| How it jumps | `CAR.launchMinSpeed`, `launchGravity`, `airGravity`, `launchMaxSpeed` |
| Trees | `PROPS.trees`, `PROPS.clusters`, `PROPS.maxHeight` (how high up they grow) |
| Tree wrecking | `CAR.breakSpeedKmh`, `breakSlowdown` |
| Drowning | `CAR.waterRespawnDelay`, `waterDrag` |
| The view | `CAMERA.distance`, `CAMERA.height`, `CAMERA.damp` |

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
- Water is a simple animated plane rather than `three`'s `Water` addon, whose normal map is
  not shipped inside the npm package and would 404.
- The car is procedural, not a loaded `.glb`. To swap in a real model, replace
  `buildCar()` in `src/car/carModel.js` with a `GLTFLoader` call that returns the same
  contract: `{ group, wheels[], steerPivots[] }`.
- Collision is intentionally limited: trees and the waterline, no car-to-car or car-to-rock
  collision, and no rollover — the chassis can tilt up to `CAR.maxTilt` but never flips.
- The island is one continuous landmass. The falloff guarantees water all around it, but it
  does not carve inland lakes.
